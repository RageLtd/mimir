/**
 * Convert markdown-heading-structured text to XML-nested format.
 *
 * Markdown headings (# h1, ## h2, ### h3) become nested XML tags.
 * Tag names are slugified from the heading text (lowercase, spaces
 * and special chars to underscores). Content between headings becomes
 * the text content of the enclosing tag.
 *
 * Example:
 *   # Critical Rules          →  <critical_rules>
 *   Do the thing.                  Do the thing.
 *   ## Code Quality            →  <code_quality>
 *   Write good code.               Write good code.
 *   # Identity                 →  </code_quality>
 *                                  </critical_rules>
 *                                  <identity>
 *
 * Content before the first heading is wrapped in a <preamble> tag.
 *
 * Originally in packages/cc-plugin/src/markdown-to-xml.ts; the
 * Anthropic-specific environment + override blocks split out into
 * the cc-plugin's wrapper file because they're CC-specific concerns.
 * The pure converter lives here so any adapter (CC, ACP, future OC)
 * can use the same heading-to-tag structure.
 */

const slugify = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_");

const headingLevel = (line: string) => {
  const match = line.match(/^(#{1,6})\s/);
  return match?.[1]?.length ?? 0;
};

const headingText = (line: string) => line.replace(/^#{1,6}\s+/, "").trim();

export const markdownToXml = (markdown: string) => {
  const lines = markdown.split("\n");
  const output: string[] = [];

  // Stack tracks open tags: [{ tag, level }]
  const stack: { tag: string; level: number }[] = [];
  let inPreamble = false;

  const closeToLevel = (targetLevel: number) => {
    while (
      stack.length > 0 &&
      (stack[stack.length - 1]?.level ?? 0) >= targetLevel
    ) {
      const entry = stack.pop();
      if (entry) output.push(`</${entry.tag}>`);
    }
  };

  for (const line of lines) {
    const level = headingLevel(line);

    if (level > 0) {
      // Close preamble if open
      if (inPreamble) {
        output.push("</preamble>");
        inPreamble = false;
      }

      // Close any tags at this level or deeper
      closeToLevel(level);

      // Open new tag
      const tag = slugify(headingText(line));
      stack.push({ tag, level });
      output.push(`<${tag}>`);
    } else {
      // Content line — if before any heading, wrap in preamble
      if (stack.length === 0 && !inPreamble && line.trim().length > 0) {
        output.push("<preamble>");
        inPreamble = true;
      }
      output.push(line);
    }
  }

  // Close preamble if still open (no headings in the doc)
  if (inPreamble) {
    output.push("</preamble>");
  }

  // Close all remaining open tags
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry) output.push(`</${entry.tag}>`);
  }

  return output.join("\n");
};
