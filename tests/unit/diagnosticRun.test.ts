import { describe, expect, it } from 'vitest';
import {
  failedAsyncToolIds,
  runDiagnosticToolSet,
  type DiagTool,
  type RollupResult,
} from '../../src/ui/panels/diagnostics';
import type { Verdict } from '../../src/ui/panels/verdict';

const okVerdict = (): Verdict => ({
  level: 'ok',
  headline: '정상',
  metrics: [],
  actions: [],
  evidence: [],
  context: [],
});

const tool = (id: string, probe: () => Promise<Verdict>): DiagTool => ({
  id,
  group: 'local',
  icon: '🧪',
  label: id,
  hint: id,
  question: `${id}?`,
  reads: 'fixture',
  mode: 'async',
  writes: '없음',
  probe,
});

describe('diagnostic run snapshot', () => {
  it('도구들을 직렬이 아니라 함께 시작하고 완료 진행을 보고한다', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const makeProbe = (id: string) => async (): Promise<Verdict> => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return okVerdict();
    };
    const progress: string[] = [];
    const running = runDiagnosticToolSet(
      [tool('a', makeProbe('a')), tool('b', makeProbe('b'))],
      (value) => progress.push(`${value.completed}/${value.total}`),
    );

    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);
    releases.forEach((release) => release());
    await running;
    expect(progress).toEqual(['1/2', '2/2']);
  });

  it('문제와 일시적 확인 불가 중 실행형 도구만 재시도 대상으로 고른다', () => {
    const entry = (id: string, level: 'ok' | 'problem' | 'unknown', unknownKind: 'structural' | 'transient') => ({
      id,
      label: id,
      level,
      unknownKind,
      headline: id,
      metrics: [],
    });
    const result: RollupResult = {
      level: 'problem',
      bannerLevel: 'problem',
      structuralCount: 1,
      observedAt: new Date(0).toISOString(),
      per: [
        entry('sync', 'problem', 'transient'),
        entry('contract', 'unknown', 'transient'),
        entry('storage', 'problem', 'transient'),
        entry('fleet', 'unknown', 'structural'),
      ],
    };

    expect(failedAsyncToolIds(result)).toEqual(['sync', 'contract']);
  });
});
