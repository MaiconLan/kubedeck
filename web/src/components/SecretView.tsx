import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { t } from '../i18n';
import { CopyButton, Empty, ErrorBanner, Icon, Spinner } from './ui';

export function SecretView({ ctx, ns, name }: { ctx: string; ns: string; name: string }) {
  const { data, error, loading, reload } = useAsync(() => api.secret(ctx, name, ns), [ctx, ns, name]);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);

  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (loading && !data) return <div className="pad"><Spinner /></div>;
  if (!data || data.values.length === 0) return <Empty title={t('secret.empty')} />;

  const exportEnv = data.values
    .filter((v) => !v.binary && !v.value.includes('\n'))
    .map((v) => `${v.key}=${v.value}`)
    .join('\n');

  return (
    <div className="secret">
      <div className="secret-head">
        <span className="muted">{t('secret.summary', { type: data.type, n: data.values.length })}</span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => { setAll(!all); setShown({}); }}>
          <Icon name={all ? 'eyeOff' : 'eye'} /> {all ? t('secret.hideAll') : t('secret.showAll')}
        </button>
        {exportEnv && <CopyButton text={exportEnv} label={t('secret.copyEnv')} />}
      </div>
      {data.values.map((v) => {
        const visible = all || shown[v.key];
        const pretty = visible ? prettify(v.value) : '';
        return (
          <div key={v.key} className="secret-row">
            <div className="secret-key">
              <code>{v.key}</code>
              <span className="muted small">{[t('secret.bytes', { n: v.bytes }), v.binary && t('secret.binary'), kindHint(v.value)].filter(Boolean).join(' · ')}</span>
              <span className="spacer" />
              <button className="btn btn-ghost btn-sm" onClick={() => setShown({ ...shown, [v.key]: !shown[v.key] })}>
                <Icon name={visible ? 'eyeOff' : 'eye'} />
              </button>
              <CopyButton text={v.value} label="" />
            </div>
            <pre className={`secret-value${visible ? '' : ' masked'}`}>
              {visible ? pretty : '•'.repeat(Math.min(24, Math.max(8, v.bytes)))}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function prettify(value: string): string {
  const t = value.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return value;
}

function kindHint(value: string): string {
  if (value.includes('-----BEGIN CERTIFICATE-----')) return t('secret.cert');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return t('secret.privateKey');
  if (/^\s*[{[]/.test(value)) return t('secret.json');
  if (/^eyJ[\w-]+\.[\w-]+\./.test(value)) return t('secret.jwt');
  return '';
}
