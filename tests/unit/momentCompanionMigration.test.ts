import { describe, expect, it } from 'vitest';
import sql from '../../supabase/migrations/20260813113101_add_moment_companion_names.sql?raw';

describe('moment companion_names migration exact-set 계약', () => {
  it('옛 행을 빈 값으로 백필하는 non-null 열을 추가한다', () => {
    expect(sql).toMatch(/add column if not exists companion_names text not null default ''/);
  });

  it('canonical moments delete→insert가 companion_names를 함께 왕복한다', () => {
    const momentInsert = sql.match(/insert into journey\.moments\([\s\S]*?from jsonb_to_recordset\(p_moments\) as x\([\s\S]*?\n  \);/)?.[0] ?? '';
    expect(momentInsert).toContain('companion_names');
    expect(momentInsert).toContain("coalesce(x.companion_names,'')");
    expect(momentInsert).toMatch(/emotion text,companion_names text,place_name text/);
  });

  it('영상을 모르는 구형 11인자 RPC 실행권을 다시 열지 않는다', () => {
    expect(sql).toMatch(/revoke all on function journey\.publish_canonical_snapshot\([\s\S]*?uuid\[\][\s\S]*?\) from public, anon, authenticated/);
    expect(sql).not.toMatch(/grant execute[\s\S]*?uuid\[\][\s\S]*?to authenticated/);
  });
});
