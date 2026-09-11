import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Notice } from '../../components/ui';
import { href, navigate } from '../../app/router';

/**
 * 7.9 — Remote device pairing (FR-021).
 *
 * A device without a session gets a 401 on every read. This screen lets the operator
 * present the single-use pairing code printed on the server's terminal to obtain an
 * HttpOnly session cookie. No secret is ever stored, read, or held in JavaScript.
 */
/**
 * `bed21f32ca23` → `bed2-1f32-ca23`, as it is typed.
 *
 * The server prints the code in groups of four and the field accepted a free string, so
 * the two forms a person naturally produces — typing the groups, or pasting the line from
 * the terminal — had to be made identical by hand. Everything that is not a hex digit is
 * dropped, which absorbs the dashes on a paste and the space somebody types instead of
 * one; twelve digits is the whole code, and anything past that is not silently kept.
 *
 * Formatting only. The code is still whatever the server minted, and the server is still
 * the only thing that decides whether it is good.
 */
export function maskPairingCode(raw: string): string {
  const digits = raw.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 12);
  return (digits.match(/.{1,4}/g) ?? []).join('-');
}

export function PairingPage({ onPaired }: { readonly onPaired?: () => void } = {}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Deck Browser');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = code.trim();
    if (cleanCode === '') {
      setError(t.pairing.codeRequired);
      return;
    }

    setSubmitting(true);
    setError(undefined);

    try {
      await api.pair(cleanCode, label.trim() || 'Deck Browser');
      if (onPaired !== undefined) {
        onPaired();
      } else {
        navigate(href({ name: 'deck' }));
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page">
      <div className="page-head crew-head">
        <div>
          <span className="eyebrow">{t.nav.pairing}</span>
          <h1 className="page-head__title">{t.pairing.title}</h1>
          <p className="page-head__sub">{t.pairing.description}</p>
        </div>
      </div>

      <div style={{ maxWidth: 520, margin: '24px auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontWeight: 500 }}>
            <span>{t.pairing.codeLabel}</span>
            <input
              type="text"
              className="input mono"
              value={code}
              onChange={(e) => setCode(maskPairingCode(e.target.value))}
              placeholder={t.pairing.codePlaceholder}
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              // 12 digits and two dashes. The mask already refuses a thirteenth, and this
              // stops a phone keyboard offering to complete past the end.
              maxLength={14}
              autoFocus
              autoComplete="off"
              spellCheck="false"
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontWeight: 500 }}>
            <span>{t.pairing.deviceLabel}</span>
            <input
              type="text"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t.pairing.devicePlaceholder}
              maxLength={40}
            />
          </label>

          {error !== undefined ? (
            <Notice tone="bad" k={t.common.refused}>
              {error}
            </Notice>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting || code.trim() === ''}
            >
              {submitting ? t.pairing.pairing : t.pairing.pairButton}
            </button>
          </div>
        </form>

        <Notice tone="idle" k="info">
          {t.pairing.restartWarning}
        </Notice>
      </div>
    </main>
  );
}
