/**
 * Safe Markdown subset for assistant text. The renderer builds React elements
 * directly — there is no HTML parsing and no `dangerouslySetInnerHTML`
 * anywhere, so raw HTML in a message can only ever render as literal text.
 * The subset covers fenced code blocks (horizontally scrollable), paragraphs
 * with line breaks, inline code, bold, and links; a link renders as an anchor
 * only for clean http(s) targets and is plain text otherwise (no javascript:,
 * no data:, no whitespace or control tricks). Everything is bounded before
 * parsing so hostile input cannot blow up the render.
 */
import type { ReactNode } from 'react'
import css from './style.module.css'

/** Character budget of one rendered message; matches the transcript cap. */
const MARKDOWN_TEXT_CAP = 16_384

/** Inline tokens: `code`, **bold**, [label](https://example.com/a%20b). */
const INLINE_TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]*\]\([^)\s]*\))/g

/**
 * Render assistant text as the safe Markdown subset.
 * @param props - the raw message text.
 * @returns the rendered block elements.
 */
export function MarkdownMessage(props: { text: string }): ReactNode {
  return <>{renderBlocks(props.text.slice(0, MARKDOWN_TEXT_CAP))}</>
}

/** Split the text into fenced code blocks and prose paragraphs. */
function renderBlocks(text: string): ReactNode[] {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let index = 0
  let key = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.trimStart().startsWith('```')) {
      const fence = line.trim().slice(3).trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.trimStart().startsWith('```')) {
        code.push(lines[index]!)
        index += 1
      }
      // Consume the closing fence when present; an unclosed fence still renders.
      if (index < lines.length) index += 1
      blocks.push(<pre className={css.codeBlock} key={`code-${key++}`} data-fence={fence.length > 0 ? fence : undefined}>
        <code>{code.length > 0 ? code.join('\n') : ''}</code>
      </pre>)
      continue
    }
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && lines[index]!.trim().length > 0 && !lines[index]!.trimStart().startsWith('```')) {
      paragraph.push(lines[index]!)
      index += 1
    }
    blocks.push(<p className={css.prose} key={`p-${key++}`}>{renderInline(paragraph.join('\n'), key)}</p>)
  }
  return blocks
}

/** Render inline markup of one paragraph: code, bold, and safe links. */
function renderInline(text: string, blockKey: number): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let seq = 0
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const token = match[0]
    const at = match.index ?? 0
    if (at > cursor) nodes.push(text.slice(cursor, at))
    if (token.startsWith('`')) {
      nodes.push(<code className={css.inlineCode} key={`${blockKey}-${seq++}`}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${blockKey}-${seq++}`}>{token.slice(2, -2)}</strong>)
    } else {
      const link = parseLink(token)
      if (link === undefined) {
        // Not a safe link target: keep the whole token as literal text.
        nodes.push(token)
      } else {
        nodes.push(<a href={link.href} rel="noopener noreferrer nofollow" target="_blank" key={`${blockKey}-${seq++}`}>{link.label}</a>)
      }
    }
    cursor = at + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes.length > 0 ? nodes : [text]
}

/**
 * Parse one `[label](target)` token into a safe anchor: only clean absolute
 * http(s) URLs qualify.
 * @param token - the full `[...](...)` token.
 * @returns the href/label pair, or undefined when the target is not safe.
 */
function parseLink(token: string): { href: string; label: string } | undefined {
  const split = token.lastIndexOf('](')
  if (split <= 0) return undefined
  const label = token.slice(1, split)
  const href = token.slice(split + 2, -1)
  if (!/^https?:\/\//i.test(href)) return undefined
  // Reject any control characters the regex separator could not express.
  if (/[\u0000-\u001f\u007f]/.test(href)) return undefined
  try {
    // Normalize and re-check the scheme: parsing must not change it.
    const parsed = new URL(href)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return { href: parsed.href, label }
  } catch {
    return undefined
  }
}
