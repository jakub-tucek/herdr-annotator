// Bounded, dependency-free lexical coloring. No HTML, code execution or source
// rewriting. Unsupported languages and oversized/token-heavy lines stay plain.
const WORDS = {
  js: "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface keyof let new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield declare namespace abstract override infer",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield",
  c: "abstract auto bool boolean break case catch char class const continue default defer do double else enum export extends final float for func function go if implements import int interface long namespace new package private protected public return short signed sizeof static string struct super switch synchronized template this throw throws trait try typedef typename union unsigned use using var virtual void volatile while",
  sql: "add all alter and as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists false foreign from full group having in index inner insert into is join key left like limit not null offset on or order outer primary references right rollback select set table then true union unique update values view when where with",
  shell: "case do done elif else esac export fi for function if in local readonly return select then time until while",
  // Scala 2 and 3. Soft keywords that double as common identifiers (end, as, open) are left out.
  scala: "abstract case catch class def derives do else enum export extends extension final finally for forSome given if implicit import inline lazy match new object opaque override package private protected return sealed super then this throw trait transparent try type using val var while with yield",
  groovy: "abstract as assert boolean break byte case catch char class const continue def default do double else enum extends final finally float for goto if implements import in instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws trait transient try var void volatile while",
  // Pegasus schemas: declarations plus primitive and container types.
  pdl: "namespace package import record enum typeref fixed union map array includes string int long float double boolean bytes",
};
const KEYWORDS = Object.fromEntries(Object.entries(WORDS).map(([name, words]) => [name, new Set(words.split(" "))]));
const LITERALS = new Set("true false null undefined NaN Infinity None True False nil NULL TRUE FALSE".split(" "));
// Languages whose strings may open with a triple quote and span lines.
const TRIPLE_QUOTES = { python: `"'`, groovy: `"'`, scala: '"' };
const TYPES = new Set("u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 str bool char string number boolean any unknown never object".split(" "));

export function syntaxLanguage(path) {
  const name = path.split("/").pop().toLowerCase(), ext = name.split(".").pop();
  if (["scala", "sc"].includes(ext)) return "scala";
  if (["gradle", "groovy", "gvy"].includes(ext) || name === "jenkinsfile") return "groovy";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (ext === "pdl") return "pdl";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return "js";
  if (ext === "rs") return "rust";
  if (["py", "pyi"].includes(ext)) return "python";
  if (["c", "h", "cc", "cpp", "hpp", "cs", "java", "go", "swift", "kt", "php"].includes(ext)) return "c";
  if (["json", "jsonc", "avsc", "avpr"].includes(ext)) return "json";
  if (["yaml", "yml", "toml", "ini", "conf"].includes(ext)) return "config";
  if (["sh", "bash", "zsh", "fish"].includes(ext) || name === "dockerfile" || name === "makefile") return "shell";
  if (ext === "sql") return "sql";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (["html", "xml", "svg"].includes(ext)) return "html";
  return null;
}

// Raw quotes (Scala """) have no escapes: a backslash before the close is literal.
function quoteEnd(text, start, quote, raw = false) {
  for (let i = start; i < text.length; i++) {
    if (!raw && text[i] === "\\") { i++; continue; }
    if (text.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
}

export function syntaxTokens(text, language, state = {}) {
  if (!language || text.length > 8192) return [{ text, kind: "plain" }];
  if (language === "markdown") return markdownTokens(text, state);
  const tokens = [];
  const add = (value, kind) => {
    if (!value) return;
    const previous = tokens.at(-1);
    if (previous?.kind === kind) previous.text += value;
    else tokens.push({ text: value, kind });
  };
  const lineComment = ["python", "config", "shell"].includes(language) ? "#" : language === "sql" ? "--" : language === "html" ? null : "//";
  const blockStart = language === "html" ? "<!--" : ["js", "rust", "c", "json", "css", "sql", "scala", "groovy", "pdl"].includes(language) ? "/*" : null;
  const blockEnd = language === "html" ? "-->" : "*/";
  let i = 0, steps = 0;
  while (i < text.length) {
    if (++steps > 512 || tokens.length > 200) {
      state.block = false; state.quote = null;
      return [{ text, kind: "plain" }];
    }
    if (state.block) {
      const end = text.indexOf(blockEnd, i);
      const stop = end < 0 ? text.length : end + blockEnd.length;
      add(text.slice(i, stop), "comment"); i = stop;
      state.block = end < 0; continue;
    }
    if (state.quote) {
      const end = quoteEnd(text, i, state.quote, language === "scala");
      add(text.slice(i, end < 0 ? text.length : end), "string");
      i = end < 0 ? text.length : end;
      if (end >= 0) state.quote = null;
      continue;
    }
    if (lineComment && text.startsWith(lineComment, i)) { add(text.slice(i), "comment"); break; }
    if (blockStart && text.startsWith(blockStart, i)) {
      const end = text.indexOf(blockEnd, i + blockStart.length);
      const stop = end < 0 ? text.length : end + blockEnd.length;
      add(text.slice(i, stop), "comment"); i = stop; state.block = end < 0; continue;
    }
    const char = text[i];
    const lifetime = language === "rust" && char === "'" ? /^'[A-Za-z_][A-Za-z0-9_]*(?=[\s,>:;+)=\]\[&]|$)/.exec(text.slice(i))?.[0] : null;
    if (lifetime) { add(lifetime, "type"); i += lifetime.length; continue; }
    // Scala quotes only close single-character literals; 'name is a symbol.
    if (language === "scala" && char === "'") {
      const literal = /^'(?:\\u[\da-fA-F]{4}|\\.|[^'\\])'/.exec(text.slice(i))?.[0];
      add(literal ?? char, literal ? "string" : "plain"); i += literal?.length ?? 1; continue;
    }
    if (char === '"' || char === "'" || (char === "`" && language === "js")) {
      const triple = !!TRIPLE_QUOTES[language]?.includes(char) && text.startsWith(char.repeat(3), i);
      const quote = triple ? char.repeat(3) : char;
      const end = quoteEnd(text, i + quote.length, quote, language === "scala" && triple);
      // Rust lifetimes are identifiers, not unterminated character literals.
      if (language === "rust" && char === "'" && end < 0) { add(char, "plain"); i++; continue; }
      const stop = end < 0 ? text.length : end;
      const key = ["json", "config"].includes(language) && end >= 0 && /^\s*:/.test(text.slice(end));
      add(text.slice(i, stop), key ? "property" : "string");
      if (end < 0 && (triple || char === "`")) state.quote = quote;
      i = stop; continue;
    }
    if (!/[A-Za-z_$\d]/.test(char)) {
      let end = i + 1;
      while (end < text.length && !/[A-Za-z_$\d"'`]/.test(text[end])
        && !(lineComment && text.startsWith(lineComment, end))
        && !(blockStart && text.startsWith(blockStart, end))) end++;
      add(text.slice(i, end), "plain"); i = end; continue;
    }
    const rest = text.slice(i);
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)?.[0];
    if (word) {
      const following = text.slice(i + word.length);
      const keyword = language === "sql" ? word.toLowerCase() : word;
      // Scala interpolators (s"", f"", raw"") read as part of their string.
      const kind = language === "scala" && following.startsWith('"') ? "string"
        : LITERALS.has(word) ? "literal" : KEYWORDS[language]?.has(keyword) ? "keyword"
        : ["json", "config"].includes(language) && /^\s*[:=]/.test(following) ? "property"
        : language === "pdl" && /^\??\s*:/.test(following) ? "property"
        : /^\s*\(/.test(following) ? "function"
        // Gradle DSL calls usually omit parentheses: implementation 'g:a:v', dependencies {
        : language === "groovy" && /^[a-z]/.test(word) && /^\s*\{|^\s+["']/.test(following) ? "function"
        : TYPES.has(word) || /^[A-Z]/.test(word) ? "type" : "plain";
      add(word, kind); i += word.length; continue;
    }
    const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[lLfFdD](?![\w$]))?/.exec(rest)?.[0];
    if (number) { add(number, "number"); i += number.length; continue; }
    add(char, "plain"); i++;
  }
  return tokens.length > 200 ? [{ text, kind: "plain" }] : tokens;
}

// Markdown is prose: color structure only, never quotes. Fenced code stays
// uninterpreted until its closing fence, tracked in state like a block comment.
const MARKDOWN_INLINE = /(`+)[^`]*?\1|\*\*[^*]+\*\*|(?<![\w])__[^_]+__(?![\w])|(\[[^\]]*\])(\([^)\s]*\))/g;
function markdownTokens(text, state) {
  const whole = kind => text ? [{ text, kind }] : [];
  const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if (state.fence) {
    const closes = fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && !fence[2].trim();
    if (closes) state.fence = null;
    return whole(closes ? "comment" : "string");
  }
  if (fence) { state.fence = fence[1]; return whole("comment"); }
  if (/^\s{0,3}#{1,6}(?:\s|$)/.test(text)) return whole("keyword");
  if (/^\s{0,3}>/.test(text)) return whole("comment");
  const tokens = [];
  const add = (value, kind) => {
    if (!value) return;
    if (tokens.at(-1)?.kind === kind) tokens.at(-1).text += value; else tokens.push({ text: value, kind });
  };
  const marker = /^(\s*)([-*+]|\d{1,9}[.)])(?=\s|$)/.exec(text);
  let i = 0;
  if (marker) { add(marker[1], "plain"); add(marker[2], "number"); i = marker[0].length; }
  for (const match of text.matchAll(MARKDOWN_INLINE)) {
    if (match.index < i) continue;
    add(text.slice(i, match.index), "plain");
    if (match[3]) { add(match[2], "function"); add(match[3], "comment"); }
    else add(match[0], match[1] ? "string" : "type");
    i = match.index + match[0].length;
    if (tokens.length > 200) return [{ text, kind: "plain" }];
  }
  add(text.slice(i), "plain");
  return tokens;
}

// Semantic mode: plain identifiers get a per-file color slot in order of first
// appearance, so the same name reads the same everywhere in the diff. Prose and
// data formats have keys, not variables, and stay as the lexer colored them.
// Shell is excluded: `foo=1` and `$foo` lex as different words.
const SEMANTIC_LANGUAGES = new Set(["js", "rust", "python", "c", "sql", "scala", "groovy", "pdl"]);
export function colorIdentifiers(highlights, path) {
  if (!SEMANTIC_LANGUAGES.has(syntaxLanguage(path))) return highlights;
  const slots = new Map(), result = new Map();
  for (const [key, tokens] of highlights) {
    const split = [];
    for (const token of tokens) {
      if (token.kind !== "plain") { split.push(token); continue; }
      token.text.split(/([A-Za-z_$][\w$]*)/).forEach((text, index) => {
        if (!text) return;
        if (index % 2) split.push({ text, kind: "variable" });
        else if (split.at(-1)?.kind === "plain") split.at(-1).text += text;
        else split.push({ text, kind: "plain" });
      });
    }
    // Same native text-run bound as the lexer: busy lines keep lexical colors.
    if (split.length > 200) { result.set(key, tokens); continue; }
    for (const token of split) if (token.kind === "variable") {
      if (!slots.has(token.text)) slots.set(token.text, slots.size);
      token.slot = slots.get(token.text);
    }
    result.set(key, split);
  }
  return result;
}

// Twelve hues; stepping 5/12 of the wheel per slot keeps neighbouring slots far
// apart. Pastel on dark themes, deep on light ones, for contrast either way.
export function identifierColor(slot, dark) {
  const hue = ((slot * 5) % 12) * 30 + 15, s = dark ? 0.6 : 0.65, l = dark ? 0.75 : 0.3;
  const channel = n => {
    const k = (n + hue / 30) % 12, value = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// Old/new lexers advance independently: removed delimiters must not color added
// lines. Hidden gaps reset state rather than inventing the omitted source.
export function highlightDiff(rows, path) {
  const language = syntaxLanguage(path), result = new Map();
  if (!language) return result;
  const sides = { old: { line: null, state: {} }, new: { line: null, state: {} } };
  for (const row of rows) for (const side of ["old", "new"]) {
    if (row[side] == null) continue;
    const lexer = sides[side];
    if (lexer.line == null || row[side] !== lexer.line + 1) lexer.state = {};
    result.set(`${side}:${row[side]}`, syntaxTokens(row.text, language, lexer.state));
    lexer.line = row[side];
  }
  return result;
}
