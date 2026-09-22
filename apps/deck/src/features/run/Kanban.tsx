import { useMemo, useState } from 'react';
import type { BoardCardView, TaskSummaryView } from '@contracts/index.js';
import { taskTone } from '../../lib/tone';
import { useT, word } from '../../lib/i18n';
import { Chip } from '../../components/ui';

export interface KanbanProps {
  readonly tasks: readonly TaskSummaryView[] | undefined;
  readonly rows: readonly { readonly id: string; readonly title: string }[];
  readonly stateOf: (id: string) => string | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly cards?: ReadonlyMap<string, BoardCardView>;
}

type ColumnKey = 'queued' | 'ready' | 'running' | 'attention' | 'completed';

interface KanbanColumnDef {
  readonly key: ColumnKey;
  readonly titleKey: 'kanbanColQueued' | 'kanbanColReady' | 'kanbanColRunning' | 'kanbanColAttention' | 'kanbanColCompleted';
  readonly tone: 'idle' | 'live' | 'warn' | 'bad' | 'ok';
  readonly states: readonly string[];
}

const COLUMNS: readonly KanbanColumnDef[] = [
  { key: 'queued', titleKey: 'kanbanColQueued', tone: 'idle', states: ['queued'] },
  { key: 'ready', titleKey: 'kanbanColReady', tone: 'idle', states: ['ready'] },
  { key: 'running', titleKey: 'kanbanColRunning', tone: 'live', states: ['running'] },
  { key: 'attention', titleKey: 'kanbanColAttention', tone: 'warn', states: ['blocked', 'failed', 'interrupted', 'review_required'] },
  { key: 'completed', titleKey: 'kanbanColCompleted', tone: 'ok', states: ['completed'] },
];

export function Kanban({ tasks, rows, stateOf, selected, onSelect, cards }: KanbanProps) {
  const dict = useT();
  const [filter, setFilter] = useState('');

  const taskMap = useMemo(() => {
    const map = new Map<string, TaskSummaryView>();
    for (const t of tasks ?? []) {
      map.set(t.id, t);
    }
    return map;
  }, [tasks]);

  const items = useMemo(() => {
    return rows.map((row) => {
      const summary = taskMap.get(row.id);
      const state = stateOf(row.id) ?? summary?.state ?? 'queued';
      const card = cards?.get(row.id);
      return {
        id: row.id,
        title: summary?.title || row.title || row.id,
        state,
        complexity: summary?.complexity ?? card?.task.complexity ?? 'normal',
        risk: summary?.risk ?? card?.task.risk ?? 'low',
        attempts: summary?.attempts ?? card?.task.attempts ?? 0,
        dependencies: summary?.dependencies ?? card?.task.dependencies ?? [],
        requirements: summary?.requirements ?? card?.task.requirements ?? [],
        runner: summary?.runner ?? card?.task.runner,
        model: summary?.model ?? card?.task.model,
        blockReason: summary?.blockReason ?? card?.task.blockReason,
      };
    });
  }, [rows, taskMap, stateOf, cards]);

  const filteredItems = useMemo(() => {
    if (!filter.trim()) return items;
    const q = filter.toLowerCase();
    return items.filter((item) => item.id.toLowerCase().includes(q) || item.title.toLowerCase().includes(q));
  }, [items, filter]);

  const grouped = useMemo(() => {
    const map = new Map<ColumnKey, typeof items>();
    for (const col of COLUMNS) {
      map.set(col.key, []);
    }
    for (const item of filteredItems) {
      let targetCol: ColumnKey = 'queued';
      if (item.state === 'ready') targetCol = 'ready';
      else if (item.state === 'running') targetCol = 'running';
      else if (['blocked', 'failed', 'interrupted', 'review_required'].includes(item.state)) targetCol = 'attention';
      else if (item.state === 'completed') targetCol = 'completed';
      map.get(targetCol)?.push(item);
    }
    return map;
  }, [filteredItems]);

  return (
    <div className="kanban">
      <div className="kanban__toolbar">
        <div className="kanban__filter">
          <input
            type="search"
            className="input input--sm"
            placeholder="Filtrar tarefas por ID ou título..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filtrar tarefas no Kanban"
          />
          {filter ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFilter('')}>
              Limpar
            </button>
          ) : null}
        </div>
        <div className="kanban__stats">
          <span className="kanban__stat-item">
            Total: <b>{items.length}</b>
          </span>
          <span className="kanban__stat-item">
            Concluídas: <b style={{ color: 'var(--ok)' }}>{grouped.get('completed')?.length ?? 0}</b>
          </span>
          <span className="kanban__stat-item">
            Em execução: <b style={{ color: 'var(--live)' }}>{grouped.get('running')?.length ?? 0}</b>
          </span>
          {(grouped.get('attention')?.length ?? 0) > 0 ? (
            <span className="kanban__stat-item">
              Atenção: <b style={{ color: 'var(--warn)' }}>{grouped.get('attention')?.length ?? 0}</b>
            </span>
          ) : null}
        </div>
      </div>

      <div className="kanban__board">
        {COLUMNS.map((col) => {
          const colItems = grouped.get(col.key) ?? [];
          return (
            <div key={col.key} className="kanban__col" data-col={col.key}>
              <div className="kanban__col-head">
                <span className="kanban__col-dot" data-tone={col.tone} />
                <span className="kanban__col-title">{dict.run[col.titleKey]}</span>
                <span className="kanban__col-count">{colItems.length}</span>
              </div>
              <div className="kanban__col-body">
                {colItems.length === 0 ? (
                  <div className="kanban__empty">{dict.run.emptyColumn}</div>
                ) : (
                  colItems.map((item) => {
                    const isSelected = selected === item.id;
                    const tone = taskTone(item.state);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="kanban-card"
                        data-selected={isSelected}
                        data-state={item.state}
                        onClick={() => onSelect(isSelected ? undefined : item.id)}
                      >
                        <div className="kanban-card__head">
                          <span className="kanban-card__id">{item.id}</span>
                          <div className="kanban-card__tags">
                            {item.complexity !== 'normal' ? (
                              <span className="kanban-card__tag" data-complexity={item.complexity}>
                                {item.complexity}
                              </span>
                            ) : null}
                            <Chip tone={tone} plain>
                              {word(dict, item.state)}
                            </Chip>
                          </div>
                        </div>

                        <div className="kanban-card__title">{item.title}</div>

                        <div className="kanban-card__footer">
                          {item.attempts > 0 ? (
                            <span className="kanban-card__meta" title={`Tentativas: ${item.attempts}`}>
                              tentativa {item.attempts}
                            </span>
                          ) : null}
                          {item.dependencies.length > 0 ? (
                            <span className="kanban-card__meta" title={`Dependências: ${item.dependencies.join(', ')}`}>
                              {item.dependencies.length} dep{item.dependencies.length === 1 ? '' : 's'}
                            </span>
                          ) : null}
                          {item.runner ? (
                            <span className="kanban-card__meta kanban-card__runner">
                              {item.runner}
                            </span>
                          ) : null}
                          {item.blockReason ? (
                            <span className="kanban-card__meta" style={{ color: 'var(--warn)' }}>
                              bloqueio: {item.blockReason}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
