-- 0017_unpurge_for_restore.sql — **백업 복원이 영구삭제 원장에 막혀 조용히 무효화되던 것**을 푼다.
--
-- 증상(사용자 실기기 2026-07-26): 백업을 복원했는데 *"복원 내용은 앱에는 하나도 없고 서버에만
-- 좀비처럼 살아났어요."* 실제 상태 — 서버 행 전부 0, 원장 24건, R2에 고아 사진 파일 10개.
--
-- 무슨 일이 벌어졌나:
--   ① 복원이 로컬에 행을 만들고 **로컬** 영구삭제 표식을 걷어낸다(그 의도는 backup.ts에 적혀 있다).
--   ② push → 0012의 BEFORE INSERT 트리거가 **서버 원장을 보고 거부**한다.
--   ③ 사진 바이트는 행 upsert와 **별개로** 먼저 올라가 R2에 착지한다 → 고아 파일.
--   ④ runSync가 원장을 pull → `applyPurgedLedger`가 **로컬 행까지 지운다.**
--   ⑤ 사용자에게는 아무 오류도 보이지 않는다.
--
-- 근본형: **규칙을 한쪽에만 구현했다**(§7 비대칭). "사용자가 명시적으로 복원한 것은 영구삭제
-- 의사보다 우선한다"를 로컬에는 구현하고 서버에는 구현하지 않았다. 그리고 클라이언트에는
-- 원장을 지울 **권한 자체가 없어** 복원이 이길 방법이 원리적으로 없었다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 0013의 판단을 뒤집는가? — 아니다. **좁은 문 하나만 낸다.**
-- ─────────────────────────────────────────────────────────────────────────────
-- 0013은 *"UPDATE·DELETE는 주지 않는다 — 원장을 지울 수 있으면 좀비 차단이 통째로 뚫린다.
-- 이 비대칭은 의도다"*라고 못박았다. 그 판단은 지금도 옳다. 그래서 **테이블 DELETE 권한은
-- 여전히 주지 않는다.** 대신 이름 있는 문 하나(`unpurge_ids`)만 낸다.
--
-- 왜 복원은 통과시켜야 하는가:
--   · 좀비의 정의는 **"사정 모르는 다른 기기가 자기 사본을 다시 올리는 것"**이다.
--     사용자가 백업 파일을 골라 명시적으로 복원하는 것은 좀비가 아니라 **새 의도**다.
--     ADR-0030이 "2단계 확인을 거친 명시적 의도"라며 영구삭제에 하드 삭제를 허용한 것과 같은 논리.
--   · 비타협 원칙 #1(사용자의 기억을 잃지 않는다). 백업 복원은 **기억의 마지막 방어선**이고,
--     좀비 차단은 그 아래 층의 정합성 장치다. 층이 충돌하면 기억이 이긴다.
--
-- 이 문이 좁은 이유:
--   · `SECURITY DEFINER`지만 **자기 행만** 지운다(`user_id = auth.uid()`) — 남의 원장은 못 건드린다.
--   · 초대제(`is_allowed()`)를 통과해야 한다(형제와 동일).
--   · **명시한 id만** 지운다. 전체 비우기는 없다.
--   · 테이블에 DELETE를 grant하지 않으므로 이 함수 **밖에서는** 여전히 지울 수 없다.
--
-- 되돌리기: drop function journey.unpurge_ids(uuid[]);
--   (되돌리면 복원이 다시 조용히 무효화된다 — 되돌리기 전에 그 대가를 확인할 것)

create or replace function journey.unpurge_ids(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = journey, public
as $$
declare
  n integer;
begin
  -- 초대제 밖 사용자는 아무것도 못 한다(형제 정책과 같은 층).
  if not journey.is_allowed() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  -- **자기 행만.** SECURITY DEFINER가 RLS를 우회하므로 소유자 조건을 여기서 직접 건다 —
  -- 이 한 줄이 이 함수의 전체 방어선이다.
  delete from journey.purged_ids
   where id = any(p_ids)
     and user_id = auth.uid();

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function journey.unpurge_ids(uuid[]) from public;
grant execute on function journey.unpurge_ids(uuid[]) to authenticated;

comment on function journey.unpurge_ids(uuid[]) is
  '백업 복원 전용 — 지정한 id를 이 사용자의 영구삭제 원장에서 제거한다. 테이블 DELETE 권한은 여전히 없다(0013의 판단 유지). 사용자가 자기 백업을 명시적으로 복원하는 것은 좀비가 아니라 새 의도이므로, 그 경우에만 이 문을 지난다.';
