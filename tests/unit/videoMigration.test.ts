import { describe, expect, it } from 'vitest';
import sql from '../../supabase/migrations/0030_journey_videos.sql?raw';

describe('migration 0030 영상 exact-set·보안 계약', () => {
  it('기존 영상 전부를 사용자 범위에서 비운 뒤 스냅샷만 다시 넣는다', () => {
    const remove = sql.indexOf('delete from journey.videos where user_id=v_user');
    const insert = sql.indexOf('insert into journey.videos');
    expect(remove).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(remove);
  });

  it('구형 6도메인 canonical RPC를 authenticated에 열어 두지 않는다', () => {
    expect(sql).toMatch(/revoke execute on function journey\.publish_canonical_snapshot\([\s\S]*?uuid\[\][\s\S]*?\) from authenticated/);
  });

  it('새 RPC와 videos 표는 owner RLS·authenticated grant를 함께 갖는다', () => {
    expect(sql).toContain('alter table journey.videos enable row level security');
    expect(sql).toContain('create policy videos_select_own');
    expect(sql).toMatch(/grant execute on function journey\.publish_canonical_snapshot\([\s\S]*?uuid\[\],jsonb[\s\S]*?\) to authenticated/);
  });
});
