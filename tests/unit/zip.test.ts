// zip 경계 테스트 — 무압축 store ZIP 라이터/리더의 왕복·CRC·폴더 경로·매직바이트.
import { describe, it, expect } from 'vitest';
import { crc32, zipStore, unzip, looksLikeZip, type ZipEntry } from '../../src/services/zip';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('zip store', () => {
  it('CRC32는 알려진 벡터와 일치("123456789" = 0xCBF43926)', () => {
    expect(crc32(enc.encode('123456789')) >>> 0).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0); // 빈 입력
  });

  it('매직바이트: store ZIP은 PK\\x03\\x04로 시작', async () => {
    const blob = zipStore([{ name: 'a.txt', data: enc.encode('hi') }]);
    const head = new Uint8Array(await blob.arrayBuffer()).slice(0, 4);
    expect(looksLikeZip(head)).toBe(true);
    expect(looksLikeZip(enc.encode('{')).valueOf()).toBe(false); // JSON은 아님
  });

  it('왕복: 여러 폴더·바이너리·한글 폴더명 보존', async () => {
    const bin = new Uint8Array([0, 255, 127, 128, 1, 2, 3]);
    const entries: ZipEntry[] = [
      { name: '도쿄__a1b2c3d4/trip.json', data: enc.encode('{"t":1}') },
      { name: '도쿄__a1b2c3d4/photos/x.webp', data: bin },
      { name: '_orphans/orphans.json', data: enc.encode('{"o":true}') },
      { name: 'manifest.json', data: enc.encode('{"app":"bugeon-journey"}') },
    ];
    const blob = zipStore(entries);
    const back = unzip(await blob.arrayBuffer());

    expect(back.length).toBe(4);
    const map = new Map(back.map((e) => [e.name, e.data]));
    expect(dec.decode(map.get('도쿄__a1b2c3d4/trip.json')!)).toBe('{"t":1}');
    expect([...map.get('도쿄__a1b2c3d4/photos/x.webp')!]).toEqual([...bin]);
    expect(dec.decode(map.get('_orphans/orphans.json')!)).toBe('{"o":true}');
    expect(dec.decode(map.get('manifest.json')!)).toBe('{"app":"bugeon-journey"}');
  });

  it('큰 이름·다수 엔트리에서도 오프셋 정합(중앙 디렉터리 순회)', async () => {
    const entries: ZipEntry[] = Array.from({ length: 50 }, (_, i) => ({
      name: `여행_${i}/photos/${i}.webp`,
      data: enc.encode('x'.repeat(i)),
    }));
    const back = unzip(await zipStore(entries).arrayBuffer());
    expect(back.length).toBe(50);
    for (let i = 0; i < 50; i += 1) {
      const e = back.find((x) => x.name === `여행_${i}/photos/${i}.webp`)!;
      expect(e.data.length).toBe(i);
    }
  });

  it('ZIP이 아닌 버퍼는 명확히 실패', () => {
    expect(() => unzip(enc.encode('not a zip at all').buffer)).toThrow();
  });
});
