const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const SIGNED_QUERY_FRAGMENT_PATTERN = /(^|[\s"'(])\?(?=[^\s"'<>]*(?:sig(?:nature)?|token|expire|expires|hdnts|auth|authorization|x-amz-[^=]+|x-goog-[^=]+)=)[^\s"'<>]*/giu;

export function redactText(value: string): string {
  return value.replace(URL_PATTERN, (raw) => {
    try {
      const parsed = new URL(raw);
      if (
        [
          "youtube.com",
          "www.youtube.com",
          "m.youtube.com",
          "youtu.be",
        ].includes(parsed.hostname.toLowerCase())
      ) {
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}[query-redacted]`;
      }
    } catch {
      /* replace malformed URL-shaped diagnostics wholesale */
    }
    return "[remote-url-redacted]";
  }).replace(SIGNED_QUERY_FRAGMENT_PATTERN, "$1[query-redacted]");
}

export function redactModelText(value: string): string {
  return redactText(value)
    .replace(/[A-Za-z]:(?:\\{1,2}|\/)[^\s"'<>]*/g, "[local-path-redacted]")
    .replace(
      /(^|[\s"'(])\/(?:[^\s"'<>]+\/)*[^\s"'<>]*/g,
      (_match: string, prefix: string) => `${prefix}[local-path-redacted]`,
    )
    .replace(/(?:\\\\|\/\/)[^\s"'<>]*/g, "[local-path-redacted]");
}

export function redactArgs(args: readonly string[]): string[] {
  return args.map((argument) => redactText(argument));
}
