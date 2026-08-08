// 운영 실측(2026-08-08): 새 Chrome이 첫 canonical 사진 80장을 받은 뒤 다음 media-sign
// fetch 한 번이 함수에 도착하기도 전에 끊겼다. 활성 사진이라 snapshot 전체를 막는 것은 맞지만,
// 부작용 없는 GET이 순간 단절 한 번으로 처음부터 되풀이되어서는 안 된다.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransientFunctionError, r2BlobStore } from '../../src/services/r2';

const UID = '11111111-2222-4333-8444-555555555555';
const MID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PATH = `${UID}/${MID}.webp`;

function clientWith(invoke: ReturnType<typeof vi.fn>) {
  return { functions: { invoke } } as never;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('R2 GET 제한 재시도', () => {
  it('FunctionsFetchError 한 번 뒤 다시 서명해 활성 사진을 받는다', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' } })
      .mockResolvedValueOnce({ data: { url: 'https://r2.example/signed' }, error: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['photo']), { status: 200 }));

    const pending = r2BlobStore(clientWith(invoke)).download(PATH);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.error).toBeUndefined();
    expect(await result.data?.text()).toBe('photo');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('media-sign', expect.objectContaining({ timeout: 15_000 }));
  });

  it('401·403 같은 영구 HTTP 오류는 반복하지 않는다', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status: 403 } },
    });

    const result = await r2BlobStore(clientWith(invoke)).download(PATH);

    expect(result.error).toContain('FunctionsHttpError');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('서명 뒤 R2 GET의 순간 단절도 같은 URL로 제한 재시도한다', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue({ data: { url: 'https://r2.example/signed' }, error: null });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network changed'))
      .mockResolvedValueOnce(new Response(new Blob(['recovered']), { status: 200 }));

    const pending = r2BlobStore(clientWith(invoke)).download(PATH);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(await result.data?.text()).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('404는 누락 증거이므로 재시도하지 않고 기존 fail-closed 판단에 넘긴다', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { url: 'https://r2.example/missing' }, error: null });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));

    const result = await r2BlobStore(clientWith(invoke)).download(PATH);

    expect(result).toMatchObject({ data: null, status: 404, error: 'R2 내려받기 실패(404)' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('함수 오류 분류', () => {
  it('전송·relay·429·5xx만 일시 오류로 분류한다', () => {
    expect(isTransientFunctionError({ name: 'FunctionsFetchError' })).toBe(true);
    expect(isTransientFunctionError({ name: 'FunctionsRelayError' })).toBe(true);
    expect(isTransientFunctionError({ name: 'FunctionsHttpError', context: { status: 429 } })).toBe(true);
    expect(isTransientFunctionError({ name: 'FunctionsHttpError', context: { status: 503 } })).toBe(true);
    expect(isTransientFunctionError({ name: 'FunctionsHttpError', context: { status: 404 } })).toBe(false);
  });
});
