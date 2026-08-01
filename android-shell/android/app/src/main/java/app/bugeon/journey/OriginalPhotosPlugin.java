package app.bugeon.journey;

// OriginalPhotosPlugin — **위치가 살아 있는 원본 바이트**로 사진을 고른다 (ADR-0036).
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 플러그인이 이 앱의 존재 이유인가
// ─────────────────────────────────────────────────────────────────────────────
// 안드로이드 10+는 미디어 저장소를 거쳐 사진을 주는 앱에게 EXIF 위치를 **지워서** 준다.
// 원본을 받으려면 ACCESS_MEDIA_LOCATION 권한 + MediaStore.setRequireOriginal()이 필요한데,
// **크롬은 그 권한을 요청하지 않는다.** 그래서 PWA는 무엇을 해도 위치가 지워진 사본을 받았고
// (실측 3종: 갤러리·파일 선택기 0/0, ZIP만 생존, 해시가 채팅 사본과 동일 — M-0059·§0-C),
// 이 셸이 생겼다. 셸의 네이티브 코드는 이 파일 하나다 — 나머지는 전부 웹이 한다.
//
// 흐름: SAF(ACTION_OPEN_DOCUMENT) → getMediaUri(문서 URI → MediaStore URI)
//       → setRequireOriginal → 바이트 → base64 → 웹.
//
// 🔴 실패는 조용히 원본 없이 계속한다 — 권한 거부·변환 실패 시에도 사진 자체는 돌려준다.
// 위치가 없는 사진이 사진이 없는 것보다 낫고, 위치 유무는 웹 쪽 🔬 관측 창이 그대로 보여준다
// (여기서 판정하지 않는다 — §8).

import android.Manifest;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "OriginalPhotos",
    permissions = {
      // 33+: 세분화된 미디어 권한. getMediaUri로 바꾼 MediaStore URI는 SAF 부여 밖이라 필요하다.
      @Permission(alias = "photos13", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
      // ≤32: 옛 저장소 권한이 같은 자리를 맡는다.
      @Permission(alias = "photosLegacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
      // 이것이 이 앱의 존재 이유다 — 없으면 setRequireOriginal이 예외를 던진다.
      @Permission(alias = "mediaLocation", strings = { Manifest.permission.ACCESS_MEDIA_LOCATION })
    })
public class OriginalPhotosPlugin extends Plugin {

  /** 한 번에 너무 많이 고르면 base64 브리지가 무겁다. 여행 순간 하나에 붙는 수준이면 충분하다. */
  private static final int MAX_PHOTOS = 10;

  @PluginMethod
  public void pick(PluginCall call) {
    String[] aliases = neededAliases();
    if (hasAllPermissions(aliases)) {
      launchPicker(call);
    } else {
      requestPermissionForAliases(aliases, call, "permsResult");
    }
  }

  private String[] neededAliases() {
    if (Build.VERSION.SDK_INT >= 33) return new String[] { "photos13", "mediaLocation" };
    if (Build.VERSION.SDK_INT >= 29) return new String[] { "photosLegacy", "mediaLocation" };
    return new String[] { "photosLegacy" }; // <29는 위치를 지우지 않아 setRequireOriginal이 필요 없다
  }

  private boolean hasAllPermissions(String[] aliases) {
    for (String a : aliases) {
      if (getPermissionState(a) != com.getcapacitor.PermissionState.GRANTED) return false;
    }
    return true;
  }

  @PermissionCallback
  private void permsResult(PluginCall call) {
    // 🔴 일부가 거부돼도 선택기는 연다. SAF 자체는 권한이 필요 없고, 위치만 못 살릴 뿐이다.
    // 사진을 아예 못 고르게 막는 것이 최악이다 — 위치 유무는 🔬 창이 사실대로 보여준다.
    launchPicker(call);
  }

  private void launchPicker(PluginCall call) {
    // 사진 선택기(ACTION_PICK_IMAGES)가 아니라 **SAF**를 쓴다 — 선택기 제공자의 URI는
    // getMediaUri 변환이 보장되지 않는다. SAF 문서 URI는 변환 경로가 문서화돼 있다.
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.setType("image/*");
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    startActivityForResult(call, intent, "pickResult");
  }

  @ActivityCallback
  private void pickResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    JSArray photos = new JSArray();
    if (result.getResultCode() == android.app.Activity.RESULT_OK && result.getData() != null) {
      List<Uri> uris = new ArrayList<>();
      Intent data = result.getData();
      if (data.getClipData() != null) {
        int n = Math.min(data.getClipData().getItemCount(), MAX_PHOTOS);
        for (int i = 0; i < n; i++) uris.add(data.getClipData().getItemAt(i).getUri());
      } else if (data.getData() != null) {
        uris.add(data.getData());
      }
      for (Uri uri : uris) {
        JSObject one = readOne(uri);
        if (one != null) photos.put(one);
      }
    }
    JSObject ret = new JSObject();
    ret.put("photos", photos);
    call.resolve(ret); // 취소는 빈 배열 — 오류가 아니다
  }

  /** 한 장을 원본으로 읽는다. 원본 승격이 실패하면 **그 단계만 조용히 내려간다**(사진은 돌려준다). */
  private JSObject readOne(Uri picked) {
    Uri uri = picked;
    boolean original = false;
    if (Build.VERSION.SDK_INT >= 29) {
      try {
        // 문서 URI → MediaStore URI. 이 변환 없이는 setRequireOriginal이 그 URI를 못 받는다.
        if (DocumentsContract.isDocumentUri(getContext(), uri)) {
          Uri media = MediaStore.getMediaUri(getContext(), uri);
          if (media != null) uri = media;
        }
        uri = MediaStore.setRequireOriginal(uri);
        original = true;
      } catch (Exception e) {
        uri = picked; // 변환·승격 실패 → SAF가 준 그대로(위치는 지워졌을 수 있음)
        original = false;
      }
    }
    try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
      if (in == null) return null;
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      byte[] chunk = new byte[64 * 1024];
      int n;
      while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
      JSObject one = new JSObject();
      one.put("name", displayName(picked));
      one.put("data", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
      // 웹 쪽 🔬 창이 「원본 승격이 실제로 됐는가」까지 관측할 수 있게 사실을 함께 준다.
      one.put("original", original);
      return one;
    } catch (Exception e) {
      // 승격된 URI가 읽기를 거부하면(권한 조합 문제) 원래 URI로 한 번 더 — 사진을 잃지 않는다.
      try (InputStream in2 = getContext().getContentResolver().openInputStream(picked)) {
        if (in2 == null) return null;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        int n;
        while ((n = in2.read(chunk)) > 0) buf.write(chunk, 0, n);
        JSObject one = new JSObject();
        one.put("name", displayName(picked));
        one.put("data", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
        one.put("original", false);
        return one;
      } catch (Exception e2) {
        return null;
      }
    }
  }

  private String displayName(Uri uri) {
    try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        String name = c.getString(0);
        if (name != null && !name.isEmpty()) return name;
      }
    } catch (Exception ignored) {
      // 이름을 못 읽는 것은 무해 — 아래 폴백으로 간다.
    }
    return "photo.jpg";
  }
}
