package app.bugeon.journey;

// 큰 백업 파일을 JS↔네이티브 브리지 한 번에 base64로 넘기지 않는다. 기본은 MediaStore의
// Download/Bugeon Journey, 보조 경로는 SAF로 고른 URI에 256KiB 청크를 순서대로 쓴다.
// 두 경로 모두 같은 URI를 다시 읽어 SHA-256과 길이를 대조한다.
// 쓰기 실패·취소 시 이 플러그인이 만든 미완성 문서만 제거한다. 외부 원본에는 손대지 않는다.

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.UUID;

@CapacitorPlugin(name = "BackupFiles")
public class BackupFilesPlugin extends Plugin {
  private Uri activeUri;
  private OutputStream activeOutput;
  private MessageDigest writeDigest;
  private String activeToken;
  private String activeName;
  private String activeDestination;
  private long writtenBytes;
  private boolean beginPending;

  @PluginMethod
  public synchronized void begin(PluginCall call) {
    if (beginPending || activeToken != null) {
      call.reject("다른 백업 파일을 저장하는 중입니다.");
      return;
    }
    String filename = call.getString("filename", "Bugeon-Journey.zip");
    String mime = call.getString("mime", "application/zip");
    String destination = call.getString("destination", "picker");
    if ("downloads".equals(destination) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      try {
        beginDownloads(call, filename, mime);
        return;
      } catch (Exception error) {
        // 기기 제공자가 MediaStore Downloads 생성을 지원하지 않으면 SAF로 안전하게 내려간다.
        deleteActiveDocument();
        clearActive();
      }
    }
    launchPicker(call, filename, mime);
  }

  private void launchPicker(PluginCall call, String filename, String mime) {
    beginPending = true;
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType(mime);
    intent.putExtra(Intent.EXTRA_TITLE, filename);
    try {
      startActivityForResult(call, intent, "beginResult");
    } catch (Exception error) {
      beginPending = false;
      call.reject("Android 저장 창을 열지 못했습니다.", error);
    }
  }

  private void beginDownloads(PluginCall call, String filename, String mime) throws Exception {
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Bugeon Journey");
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
    Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    activeUri = getContext().getContentResolver().insert(collection, values);
    if (activeUri == null) throw new IllegalStateException("Download 폴더에 문서를 만들 수 없습니다.");
    openActive(call, activeUri, "downloads");
  }

  @ActivityCallback
  private synchronized void beginResult(PluginCall call, ActivityResult result) {
    beginPending = false;
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
      JSObject ret = new JSObject();
      ret.put("cancelled", true);
      call.resolve(ret);
      return;
    }
    try {
      openActive(call, result.getData().getData(), "picker");
    } catch (Exception error) {
      deleteActiveDocument();
      clearActive();
      call.reject("백업 파일을 열지 못했습니다.", error);
    }
  }

  private void openActive(PluginCall call, Uri uri, String destination) throws Exception {
    activeUri = uri;
    activeOutput = getContext().getContentResolver().openOutputStream(activeUri, "w");
    if (activeOutput == null) throw new IllegalStateException("출력 스트림을 열 수 없습니다.");
    writeDigest = MessageDigest.getInstance("SHA-256");
    activeToken = UUID.randomUUID().toString();
    activeName = displayName(activeUri);
    activeDestination = destination;
    writtenBytes = 0;
    JSObject ret = new JSObject();
    ret.put("token", activeToken);
    ret.put("name", activeName);
    ret.put("destination", activeDestination);
    call.resolve(ret);
  }

  @PluginMethod
  public synchronized void append(PluginCall call) {
    if (!matches(call)) return;
    String data = call.getString("data");
    String expectedSha256 = call.getString("sha256");
    if (data == null || expectedSha256 == null) {
      call.reject("저장할 백업 청크 또는 원본 해시가 없습니다.");
      return;
    }
    try {
      byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
      MessageDigest chunkDigest = MessageDigest.getInstance("SHA-256");
      String actualSha256 = hex(chunkDigest.digest(bytes));
      if (!actualSha256.equalsIgnoreCase(expectedSha256)) {
        throw new IllegalStateException("JS 원본 청크와 네이티브 수신 바이트의 해시가 다릅니다.");
      }
      activeOutput.write(bytes);
      writeDigest.update(bytes);
      writtenBytes += bytes.length;
      JSObject ret = new JSObject();
      ret.put("bytes", writtenBytes);
      call.resolve(ret);
    } catch (Exception error) {
      failAndDelete(call, "백업 파일을 쓰지 못했습니다.", error);
    }
  }

  @PluginMethod
  public synchronized void finish(PluginCall call) {
    if (!matches(call)) return;
    try {
      activeOutput.flush();
      activeOutput.close();
      activeOutput = null;
      byte[] expected = writeDigest.digest();
      MessageDigest actualDigest = MessageDigest.getInstance("SHA-256");
      long readBytes = 0;
      try (InputStream input = getContext().getContentResolver().openInputStream(activeUri)) {
        if (input == null) throw new IllegalStateException("저장한 문서를 다시 열 수 없습니다.");
        byte[] chunk = new byte[64 * 1024];
        int count;
        while ((count = input.read(chunk)) > 0) {
          actualDigest.update(chunk, 0, count);
          readBytes += count;
        }
      }
      boolean verified = writtenBytes == readBytes && MessageDigest.isEqual(expected, actualDigest.digest());
      if (!verified) throw new IllegalStateException("저장한 문서의 길이 또는 해시가 다릅니다.");
      if ("downloads".equals(activeDestination) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ContentValues ready = new ContentValues();
        ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
        int updated = getContext().getContentResolver().update(activeUri, ready, null, null);
        if (updated != 1) throw new IllegalStateException("검증한 백업 파일을 Download 폴더에 게시하지 못했습니다.");
      }
      JSObject ret = new JSObject();
      ret.put("verified", true);
      ret.put("bytes", readBytes);
      ret.put("name", activeName);
      ret.put("destination", activeDestination);
      clearActive();
      call.resolve(ret);
    } catch (Exception error) {
      failAndDelete(call, "저장한 백업을 다시 읽어 확인하지 못했습니다.", error);
    }
  }

  @PluginMethod
  public synchronized void abort(PluginCall call) {
    if (activeToken == null) {
      call.resolve();
      return;
    }
    String token = call.getString("token");
    if (!activeToken.equals(token)) {
      call.reject("다른 백업 저장 토큰입니다.");
      return;
    }
    deleteActiveDocument();
    clearActive();
    call.resolve();
  }

  private boolean matches(PluginCall call) {
    String token = call.getString("token");
    if (activeToken == null || !activeToken.equals(token) || activeOutput == null || activeUri == null) {
      call.reject("유효한 백업 저장 세션이 아닙니다.");
      return false;
    }
    return true;
  }

  private void failAndDelete(PluginCall call, String message, Exception error) {
    deleteActiveDocument();
    clearActive();
    call.reject(message, error);
  }

  private void deleteActiveDocument() {
    try {
      if (activeOutput != null) activeOutput.close();
    } catch (Exception ignored) {
      // 아래 delete가 미완성 문서 제거를 다시 시도한다.
    }
    if (activeUri != null) {
      try { getContext().getContentResolver().delete(activeUri, null, null); } catch (Exception ignored) { }
    }
  }

  private void clearActive() {
    activeUri = null;
    activeOutput = null;
    writeDigest = null;
    activeToken = null;
    activeName = null;
    activeDestination = null;
    writtenBytes = 0;
  }

  private String hex(byte[] bytes) {
    StringBuilder out = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
    return out.toString();
  }

  private String displayName(Uri uri) {
    try (android.database.Cursor cursor = getContext().getContentResolver().query(
        uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) {
        String name = cursor.getString(0);
        if (name != null && !name.isEmpty()) return name;
      }
    } catch (Exception ignored) { }
    return "Bugeon-Journey.zip";
  }

  @Override
  protected synchronized void handleOnDestroy() {
    beginPending = false;
    deleteActiveDocument();
    clearActive();
  }
}
