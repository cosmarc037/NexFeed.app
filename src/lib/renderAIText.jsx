/**
 * Shared AI text renderer.
 * Handles:
 * - **bold** markdown → <strong> (fontWeight 700)
 * - [Product Name](code) syntax → stripped to plain product name
 * - Raw 10-digit material codes in parens → stripped
 * - Section headers: **A) ...** or emoji + **...** patterns → 13px bold heading
 * - Bullet lines: lines starting with • → indented bullet style
 * - Date post-processing: YYYY-MM-DD → "Month D, YYYY"
 * - All non-header paragraphs explicitly fontWeight: 400
 */

// Convert YYYY-MM-DD dates to human-readable "Month D, YYYY"
function formatDatesInText(text) {
  if (!text) return text;
  return text.replace(/(\d{4})-(\d{2})-(\d{2})/g, (match, year, month, day) => {
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (isNaN(date.getTime())) return match;
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  });
}

// Strip [Name](code) link syntax → keep just the name
// Strip bare 10+ digit material codes in parentheses
function cleanAIText(text) {
  if (!text) return text;
  text = text.replace(/\[(.*?)\]\(\d+\)/g, '$1');
  text = text.replace(/\(\d{10,}\)/g, '');
  return text;
}

// Detect section header lines:
// - **A) ...**  (letter section: Safety Stock)
// - **📍 ...**  (emoji-wrapped: embedded in **)
// - 📍 **...**  (emoji then bold: Impact Analysis / narrative format)
const SECTION_EMOJIS = '📍⏱⚠📅💡📋⚡🤖✨📊🔴🟠🟡🟢✅';
function isSectionHeader(line) {
  const t = line.trim();
  // **A) Overview**
  if (/^\*\*[A-Z]\)/.test(t)) return true;
  // **📊 Overview** (emoji inside the **)
  if (new RegExp(`^\\*\\*[${SECTION_EMOJIS}]`).test(t)) return true;
  // 📊 **Overview** (emoji before the **)
  if (new RegExp(`^[${SECTION_EMOJIS}]\\s+\\*\\*`).test(t)) return true;
  return false;
}

// Detect horizontal rule separator
function isHorizontalRule(line) {
  return /^-{3,}$/.test(line.trim());
}

// Detect bullet lines: start with •
function isBulletLine(line) {
  return line.trim().startsWith('•');
}

// Split "📊 **Overview** trailing content" into two separate lines.
// Guards against AI outputting heading + content on one line.
function splitInlineHeaders(lines) {
  const result = [];
  for (const line of lines) {
    const t = line.trim();
    if (isSectionHeader(t)) {
      // Match: heading closes with ** then has trailing text
      const m = t.match(/^(.*?\*\*)\s+(.+)$/);
      if (m) {
        result.push(m[1].trim());
        result.push(m[2].trim());
      } else {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  return result;
}

/**
 * Render a single line with bold support.
 * - **bold** → <strong fontWeight:700>
 * - Lone * stripped
 * - Regular text explicitly fontWeight: 400 via the parent element
 */
export function renderAILine(text, baseColor = '#4b5563') {
  if (!text) return null;
  const regex = /\*\*(.*?)\*\*/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index).replace(/\*/g, ''));
    }
    parts.push(
      <strong key={match.index} style={{ fontWeight: 700, color: '#1a1a1a' }}>
        {match[1]}
      </strong>
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex).replace(/\*/g, ''));
  }

  return parts.length > 0 ? parts : null;
}

/**
 * Full block AI text renderer.
 * Outer container is fontWeight: 400 to prevent inheritance issues.
 * Only <strong> tags inside are bold (700).
 */
export function AIText({
  text,
  fontSize = 12,
  color = '#4b5563',
  lineHeight = 1.6,
  gap = 8,
  style = {},
}) {
  if (!text) return null;

  const processed = formatDatesInText(cleanAIText(text));

  // Split on double newlines first, fall back to single newlines
  const rawParagraphs = processed.split(/(?:\r?\n){2,}/);
  const lines = rawParagraphs.length > 1
    ? rawParagraphs
    : processed.split(/\r?\n/);

  const cleaned = splitInlineHeaders(lines.map(p => p.trim()).filter(Boolean));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', fontWeight: 400, ...style }}>
      {cleaned.map((line, i) => {
        const isHeader = isSectionHeader(line);
        const isBullet = isBulletLine(line);
        const isHR = isHorizontalRule(line);

        if (isHR) {
          return (
            <hr
              key={i}
              style={{
                border: 'none',
                borderTop: '1px dashed #d1d5db',
                margin: '12px 0',
              }}
            />
          );
        }

        if (isHeader) {
          // For **A) Overview** style: strip outer ** wrapping
          // For 📊 **Overview** style: leave as-is (renderAILine handles inner **)
          let headerContent = line.trim();
          if (headerContent.startsWith('**') && headerContent.endsWith('**')) {
            headerContent = headerContent.slice(2, -2);
          }
          return (
            <p
              key={i}
              style={{
                fontSize,
                fontWeight: 700,
                color: '#1a1a1a',
                lineHeight: 1.4,
                margin: 0,
                marginTop: i === 0 ? 0 : 14,
                marginBottom: 6,
              }}
            >
              {renderAILine(headerContent, '#1a1a1a')}
            </p>
          );
        }

        if (isBullet) {
          return (
            <p
              key={i}
              style={{
                fontSize,
                fontWeight: 400,
                color,
                lineHeight: 1.6,
                margin: 0,
                marginBottom: 12,
                paddingLeft: 16,
              }}
            >
              {renderAILine(line, color)}
            </p>
          );
        }

        // Regular paragraph / body text — always fontWeight: 400
        return (
          <p
            key={i}
            style={{
              fontSize,
              fontWeight: 400,
              color,
              lineHeight,
              margin: 0,
              marginBottom: gap,
            }}
          >
            {renderAILine(line, color)}
          </p>
        );
      })}
    </div>
  );
}
