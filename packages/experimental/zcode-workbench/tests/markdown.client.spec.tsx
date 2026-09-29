// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownMessage } from '../src/client/markdown.tsx'

afterEach(cleanup)

describe('safe markdown subset', () => {
  it('renders bold, inline code, and safe http(s) links', () => {
    const { container } = render(<MarkdownMessage text={'See **the report** and `npm test`, plus [docs](https://example.com/a?b=1).'} />)
    expect(container.querySelector('strong')?.textContent).toBe('the report')
    expect(container.querySelector('code')?.textContent).toBe('npm test')
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com/a?b=1')
    expect(anchor?.getAttribute('rel')).toContain('noopener')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.textContent).toBe('docs')
  })

  it('renders raw HTML as literal text — no element is ever created from message content', () => {
    const { container } = render(<MarkdownMessage text={'<img src=x onerror=alert(1)> <script>alert(2)</script>'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('<script>alert(2)</script>')
    expect(container.innerHTML).not.toContain('<img')
  })

  it('refuses non-http link schemes: javascript and data links stay plain text', () => {
    const { container } = render(<MarkdownMessage text={'[click](javascript:alert(1)) [file](data:text/html,x) [ok](https://example.com)'} />)
    const anchors = container.querySelectorAll('a')
    expect(anchors).toHaveLength(1)
    // URL parsing normalizes the bare origin with its trailing slash.
    expect(anchors[0]!.getAttribute('href')).toBe('https://example.com/')
    expect(container.textContent).toContain('[click](javascript:alert(1))')
    expect(container.textContent).toContain('[file](data:text/html,x)')
  })

  it('renders fenced code blocks as scrollable pre elements with the fence label', () => {
    const { container } = render(<MarkdownMessage text={'before\n```ts\nconst x = 1\nconst y = 2\n```\nafter'} />)
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toContain('const x = 1')
    expect(pre?.getAttribute('data-fence')).toBe('ts')
    // The horizontal-scroll affordance is part of the class, not inline styles.
    expect(pre?.className.length ?? 0).toBeGreaterThan(0)
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
  })

  it('renders an unclosed fence without losing the tail and bounds hostile length', () => {
    const { container } = render(<MarkdownMessage text={'```js\nnever closed' + 'x'.repeat(20_000)} />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect((pre?.textContent ?? '').length).toBeLessThanOrEqual(16_384)
  })

  it('keeps line structure inside paragraphs', () => {
    const { container } = render(<MarkdownMessage text={'- item one\n- item two\n\nsecond paragraph'} />)
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]!.textContent).toContain('- item one\n- item two')
    expect(paragraphs[1]!.textContent).toBe('second paragraph')
  })
})
