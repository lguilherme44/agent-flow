import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Info } from 'lucide-react';
import type { ConfigSectionView, ConfigSettingView, ConfigView } from '@contracts/index.js';
import { useProjectSelection } from '../app/project-context';
import { useConfig } from '../lib/queries';
import { Badge, Empty, Panel, SectionHeader, Tooltip, cx } from '../components/ui';
import { useI18n } from '../lib/i18n/i18n-context';

/**
 * Settings (UI-26, §85) — the configuration the tool is actually running on.
 */
export function SettingsPage(): JSX.Element {
  const { projectId } = useProjectSelection();
  const config = useConfig(projectId);

  if (config.isError) {
    return (
      <Empty
        title="The configuration could not be read."
        hint={config.error instanceof Error ? config.error.message : undefined}
      />
    );
  }

  if (config.data === undefined) {
    return <Empty title={config.isLoading ? 'Reading configuration…' : 'Nothing to show.'} />;
  }

  const data = config.data;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto">
      <Sources data={data} />

      {data.configError === undefined ? (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {data.sections.map((section) => (
            <Section key={section.id} section={section} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the configuration comes from, and whether it loaded.
 *
 * A broken config is a state this page has to show rather than a request that
 * failed, and the paths are exactly what somebody needs in order to fix it — so
 * they appear alongside the reason instead of instead of it (§95).
 */
function Sources(props: { data: ConfigView }): JSX.Element {
  const { t } = useI18n();
  const { sources, configError } = props.data;

  return (
    <Panel
      className="shrink-0"
      header={
        <SectionHeader title={t.settings.title}>
          <span className="flex items-center gap-1 text-micro text-faint">
            <Info className="h-3 w-3" aria-hidden />
            {t.settings.readOnlyNotice}
          </span>
        </SectionHeader>
      }
    >
      <div className="flex flex-col gap-2 px-4 pb-3">
        {configError === undefined ? null : (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-label text-text"
          >
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
            <span>
              <strong className="font-medium">The configuration would not load. </strong>
              {configError}
            </span>
          </p>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 xl:grid-cols-2">
          <SourceRow
            label="Global"
            path={sources.globalPath}
            present={sources.globalPresent}
            absentNote="not present — the built-in defaults are in force"
          />
          <SourceRow
            label="Project"
            path={sources.projectPath}
            present={sources.projectPresent}
            absentNote="not present — run agent-flow init in this repository"
          />
        </dl>
      </div>
    </Panel>
  );
}

function SourceRow(props: {
  label: string;
  path: string;
  present: boolean;
  absentNote: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="w-14 shrink-0 text-micro uppercase tracking-caps text-faint">
        {props.label}
      </dt>
      <dd className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-label text-text" title={props.path}>
          {props.path}
        </span>
        {props.present ? null : (
          <span className="text-micro text-faint">{props.absentNote}</span>
        )}
      </dd>
    </div>
  );
}

const ORIGIN_TONE = {
  project: 'primary',
  global: 'info',
  default: 'muted',
} as const;

const ORIGIN_LABEL = {
  project: 'Project override',
  global: 'Global',
  default: 'Default',
} as const;

function Section(props: { section: ConfigSectionView }): JSX.Element {
  const { section } = props;

  return (
    <Panel divided header={<SectionHeader title={section.title} />}>
      {section.settings.length === 0 ? (
        // Named in §85 and backed by nothing. Saying so beats a blank panel, and
        // beats a control for a setting nothing reads.
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="text-label text-muted">{section.note ?? 'Nothing to configure.'}</p>
          {section.id === 'models' ? (
            <Link
              to="/agents"
              className="flex w-fit items-center gap-1 text-label text-primary-bright hover:underline"
            >
              Open Agents &amp; Models
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          ) : null}
        </div>
      ) : (
        <dl className="flex flex-col divide-y divide-border/70">
          {section.settings.map((setting) => (
            <Setting key={setting.key} setting={setting} />
          ))}
        </dl>
      )}
    </Panel>
  );
}

function Setting(props: { setting: ConfigSettingView }): JSX.Element {
  const { setting } = props;

  return (
    <div className="flex items-baseline gap-3 px-4 py-2">
      <dt className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label text-text">{setting.label}</span>
        <span className="truncate font-mono text-micro text-faint" title={setting.key}>
          {setting.key}
        </span>
      </dt>

      <dd className="flex min-w-0 max-w-[52%] flex-col items-end gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cx(
              'truncate text-label',
              setting.note === undefined ? 'text-text' : 'text-warning',
            )}
            title={setting.value}
          >
            {setting.value}
          </span>
          <Tooltip
            content={
              <span>
                {setting.origin === 'project'
                  ? 'Set by this project, which overrides the global file.'
                  : setting.origin === 'global'
                    ? 'Set in the global config file.'
                    : 'No file mentions it — this is the built-in default.'}
              </span>
            }
          >
            <Badge tone={ORIGIN_TONE[setting.origin]} caps className="shrink-0">
              {ORIGIN_LABEL[setting.origin]}
            </Badge>
          </Tooltip>
        </span>
        {setting.note === undefined ? null : (
          <span className="text-right text-micro text-muted">{setting.note}</span>
        )}
      </dd>
    </div>
  );
}
