/** Extract only a top-level string value, never nested fields or JSON syntax. */
export function partialJsonString(
  source: string,
  field: string,
): string | undefined {
  function stringAt(start: number) {
    let value = "";
    for (let i = start + 1; i < source.length; i++) {
      const c = source[i];
      if (c === '"') return { value, end: i + 1, complete: true };
      if (c === "\\") {
        const next = source[++i];
        if (next === undefined) break;
        if (next === "u") {
          const hex = source.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
          value += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          const escapes: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (!(next in escapes)) break;
          value += escapes[next];
        }
      } else if (c.charCodeAt(0) < 32) break;
      else value += c;
    }
    // Avoid exposing half an emoji when a surrogate pair spans events.
    return {
      value: value.replace(/[\uD800-\uDBFF]$/, ""),
      end: source.length,
      complete: false,
    };
  }
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "{" || source[i] === "[") depth++;
    else if (source[i] === "}" || source[i] === "]") depth--;
    else if (source[i] === '"') {
      const token = stringAt(i);
      i = token.end - 1;
      if (!token.complete) return undefined;
      let next = token.end;
      while (/\s/.test(source[next] || "!")) next++;
      if (depth === 1 && token.value === field && source[next] === ":") {
        next++;
        while (/\s/.test(source[next] || "!")) next++;
        return source[next] === '"' ? stringAt(next).value : undefined;
      }
    }
  }
}
