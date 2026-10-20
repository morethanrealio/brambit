// Splits the onboarding reply into greeting, "to remember" facts and the 3 suggestions.
// The markers may come after a greeting OR be the very first thing in the text
// (issue #19: with a leading label the blocks came back empty because the split
// required a newline before the marker).
export function parseOnboard(text) {
  const all = text || '';
  const bullets = (chunk) => {
    const out = [];
    for (const line of (chunk || '').split('\n')) {
      const s = line.replace(/^[\s•\-*\d.]+/, '').replace(/\*\*/g, '').trim();
      if (s) out.push(s);
    }
    return out;
  };
  // Splits on the two markers; what comes before the first one is the greeting.
  // (?:^|\n) so the marker also matches at position 0.
  const sugSplit = all.split(/(?:^|\n)[ \t]*SUGEST[ÕO]ES[ \t]*:/i);
  const beforeSug = sugSplit[0];
  const remSplit = beforeSug.split(/(?:^|\n)[ \t]*PARA[_ ]LEMBRAR[ \t]*:/i);
  const welcome = remSplit[0].trim();
  const notes = bullets(remSplit[1]).slice(0, 6);
  const suggestions = bullets(sugSplit[1]).slice(0, 3);
  return { welcome, suggestions, notes };
}
