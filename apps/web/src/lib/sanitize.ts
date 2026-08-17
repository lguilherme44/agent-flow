/**
 * Sanitizes endpoint URLs to ensure no credentials, tokens, query params,
 * or userinfo material are ever leaked to the UI or logs.
 */
export function sanitizeEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return 'Not configured';
  }

  const trimmed = raw.trim();

  // If it's pure credential material without URL scheme, redact it
  if (
    !trimmed.includes('://') &&
    (/(?:sk|pk)[_-](?:live|test|proj|secret)/i.test(trimmed) ||
      /^(?:AKIA|ASIA|gh[pousr]_|xox[baprs]-|eyJ)/.test(trimmed))
  ) {
    return 'Not configured (redacted)';
  }

  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // If not a standard URL, scrub anything resembling api_key=, token=, userinfo, etc.
    const scrubbed = trimmed
      .replace(/[?&](?:api[_-]?key|token|auth|secret|key)=[^&]+/gi, '')
      .replace(/:\/\/[^@]+@/, '://')
      .replace(/\/$/, '');

    if (
      /(?:sk|pk)[_-](?:live|test|proj|secret)/i.test(scrubbed) ||
      /^(?:AKIA|ASIA|gh[pousr]_|xox[baprs]-|eyJ)/.test(scrubbed)
    ) {
      return 'Not configured (redacted)';
    }

    return scrubbed;
  }
}

