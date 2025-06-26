require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { Storage } = require("@google-cloud/storage");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
let REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const SOURCE_INVOICE_ID = process.env.SOURCE_INVOICE_ID;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;

const storage = new Storage();

async function loadRefreshTokenFromGCS() {
  try {
    console.log("[INFO] Google Cloud Storageからトークンを読み込み中...");

    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const file = bucket.file("refresh-token.txt");

    const [exists] = await file.exists();
    if (!exists) {
      console.log("[WARN] GCSにrefresh-token.txtが見つかりません");
      return null;
    }

    const [contents] = await file.download();
    const token = contents.toString().trim();

    console.log(
      `[SUCCESS] GCSからトークンを読み込みました: ${token.substring(0, 8)}...`
    );
    return token;
  } catch (error) {
    console.error("[ERROR] GCSからのトークン読み込みに失敗:", error.message);
    return null;
  }
}

async function initializeRefreshToken() {
  const isCloudRunJobs = process.env.NODE_ENV === "production";
  const hasEnvMount = fs.existsSync("/app/.env");

  // Cloud Run Jobs環境でGCSが利用可能な場合はGCSから読み込み
  if (isCloudRunJobs && !hasEnvMount && GCS_BUCKET_NAME && !REFRESH_TOKEN) {
    const gcsToken = await loadRefreshTokenFromGCS();
    if (gcsToken) {
      REFRESH_TOKEN = gcsToken;
      console.log("[INFO] GCSからのREFRESH_TOKENを使用します");
    }
  }
}

async function updateRefreshToken(newRefreshToken) {
  const isCloudRunJobs = process.env.NODE_ENV === "production";
  const hasEnvMount = fs.existsSync("/app/.env");

  // Cloud Run Jobs環境ではGCS使用、ローカルでは.envファイル更新
  if (isCloudRunJobs && !hasEnvMount && GCS_BUCKET_NAME) {
    await updateTokenInGCS(newRefreshToken);
  } else {
    await updateEnvFile(newRefreshToken);
  }

  // メモリ上のREFRESH_TOKENも更新
  REFRESH_TOKEN = newRefreshToken;
}

async function updateTokenInGCS(newRefreshToken) {
  try {
    console.log("[INFO] Google Cloud Storageにトークンを保存中...");

    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const file = bucket.file("refresh-token.txt");

    await file.save(newRefreshToken, {
      metadata: {
        contentType: "text/plain",
        cacheControl: "no-cache",
      },
    });

    console.log("[SUCCESS] Google Cloud Storageへのトークン保存が完了しました");
    console.log(
      `[INFO] 新しいREFRESH_TOKEN: ${newRefreshToken.substring(0, 8)}...`
    );
  } catch (error) {
    console.error(
      "[ERROR] Google Cloud Storageへの保存に失敗しました:",
      error.message
    );
    console.log("[WARN] 次回実行時は手動でREFRESH_TOKENを更新してください");
  }
}

async function updateEnvFile(newRefreshToken) {
  const envPath = path.join(__dirname, ".env");

  try {
    console.log("[INFO] .envファイルを更新中...");

    let envContent = fs.readFileSync(envPath, "utf8");

    const refreshTokenPattern = /^REFRESH_TOKEN=.*$/m;
    if (refreshTokenPattern.test(envContent)) {
      envContent = envContent.replace(
        refreshTokenPattern,
        `REFRESH_TOKEN=${newRefreshToken}`
      );
    } else {
      envContent += `\nREFRESH_TOKEN=${newRefreshToken}`;
    }

    fs.writeFileSync(envPath, envContent);

    console.log("[SUCCESS] .envファイルの更新が完了しました");
    console.log(
      `[INFO] 新しいREFRESH_TOKEN: ${newRefreshToken.substring(0, 8)}...`
    );
  } catch (error) {
    console.error("[ERROR] .envファイルの更新に失敗しました:", error.message);
    throw error;
  }
}

async function getTokenWithRefreshToken() {
  if (!REFRESH_TOKEN) {
    console.error("[ERROR] REFRESH_TOKENが.envに設定されていません");
    process.exit(1);
  }

  console.log(
    "[INFO] リフレッシュトークンを使用してアクセストークンを取得中..."
  );

  try {
    const res = await axios.post(
      "https://app.misoca.jp/oauth2/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        redirect_uri: REDIRECT_URI,
      }),
      {
        auth: {
          username: CLIENT_ID,
          password: CLIENT_SECRET,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 30000,
      }
    );

    console.log("[SUCCESS] リフレッシュによるアクセストークン取得成功");

    // 新しいリフレッシュトークンが発行された場合は自動更新
    if (res.data.refresh_token && res.data.refresh_token !== REFRESH_TOKEN) {
      console.log(
        "[INFO] 新しいrefresh_tokenが発行されました。自動更新します。"
      );
      await updateRefreshToken(res.data.refresh_token);
    }

    return res.data.access_token;
  } catch (e) {
    console.error("[ERROR] リフレッシュ失敗:", {
      status: e.response?.status,
      statusText: e.response?.statusText,
      data: e.response?.data,
      message: e.message,
    });

    if (
      e.response?.status === 400 &&
      e.response?.data?.error === "invalid_grant"
    ) {
      console.error(
        "[ERROR] リフレッシュトークンが無効です。以下の手順で再設定してください:"
      );
      console.error("1. MODE=setup で初回セットアップを実行");
      console.error("2. 新しいREFRESH_TOKENを取得");
      console.error("3. .envファイルに新しいREFRESH_TOKENを設定");
    }

    process.exit(1);
  }
}

async function getAccessToken() {
  if (REFRESH_TOKEN) {
    return await getTokenWithRefreshToken();
  } else {
    console.error(
      "[ERROR] REFRESH_TOKENが設定されていません。初回セットアップを実行してください。"
    );
    process.exit(1);
  }
}

async function getSourceInvoice(accessToken) {
  console.log(`[INFO] 元請求書を取得中... (ID: ${SOURCE_INVOICE_ID})`);

  try {
    const res = await axios.get(
      `https://app.misoca.jp/api/v3/invoice/${SOURCE_INVOICE_ID}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    console.log(`[SUCCESS] 元請求書取得成功: "${res.data.subject}"`);
    console.log(`[INFO] 請求先: ${res.data.contact_name || "取引先情報なし"}`);
    console.log(`[INFO] 明細数: ${res.data.items?.length || 0}件`);

    return res.data;
  } catch (e) {
    console.error("[ERROR] 元請求書取得失敗:", {
      status: e.response?.status,
      statusText: e.response?.statusText,
      data: e.response?.data,
      message: e.message,
    });
    process.exit(1);
  }
}

async function duplicateInvoice(accessToken, sourceInvoice) {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  // 月末を発行日に設定
  const lastDay = new Date(currentYear, currentMonth, 0).getDate();
  const issueDate = `${currentYear}-${currentMonth
    .toString()
    .padStart(2, "0")}-${lastDay}`;

  // 翌月末を支払期限に設定
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
  const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
  const nextMonthLastDay = new Date(nextYear, nextMonth, 0).getDate();
  const dueDate = `${nextYear}-${nextMonth
    .toString()
    .padStart(2, "0")}-${nextMonthLastDay}`;

  // Subjectから既存の月分表記を抽出して、当月分に置き換え
  let newSubject = sourceInvoice.subject;

  // 「○月分」のパターンを検索して置換
  const monthPattern = /(\d{1,2})月分/;
  if (monthPattern.test(newSubject)) {
    newSubject = newSubject.replace(monthPattern, `${currentMonth}月分`);
  } else {
    // 月分表記がない場合は追加
    const baseSubject = newSubject.replace(/（.*?月分.*?）/, ""); // 既存の括弧内月分表記を削除
    newSubject = `${baseSubject.trim()} ${currentMonth}月分`.replace(
      / +/g,
      " "
    ); // 余分なスペースを削除
  }

  const duplicateData = {
    subject: newSubject,
    contact_id: sourceInvoice.contact_id,
    issue_date: issueDate,
    payment_due_on: dueDate,
    body: sourceInvoice.body,
    items: sourceInvoice.items,
  };

  console.log(`[INFO] 請求書を複製中...`);
  console.log(`[INFO] 複製後タイトル: "${duplicateData.subject}"`);
  console.log(`[INFO] 発行日: ${issueDate}, 支払期限: ${dueDate}`);

  try {
    const res = await axios.post(
      "https://app.misoca.jp/api/v3/invoice",
      duplicateData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    console.log(`[SUCCESS] 請求書複製成功: "${res.data.subject}"`);
    console.log(`[SUCCESS] 新規請求書ID: ${res.data.id}`);
    console.log(
      `[INFO] 請求書URL: https://app.misoca.jp/invoices/${res.data.id}`
    );

    return res.data;
  } catch (e) {
    console.error("[ERROR] 請求書複製失敗:", {
      status: e.response?.status,
      statusText: e.response?.statusText,
      data: e.response?.data,
      message: e.message,
    });

    if (e.response?.status === 422) {
      console.error(
        "[ERROR] バリデーションエラーの可能性があります。請求書データを確認してください。"
      );
    } else if (e.response?.status === 401) {
      console.error(
        "[ERROR] 認証エラー。アクセストークンが無効な可能性があります。"
      );
    }

    process.exit(1);
  }
}

async function duplicateMonthlyInvoice() {
  const startTime = new Date();
  console.log(`[INFO] 月次請求書複製処理開始: ${startTime.toISOString()}`);

  if (!SOURCE_INVOICE_ID) {
    console.error("[ERROR] SOURCE_INVOICE_IDが.envに設定されていません");
    process.exit(1);
  }

  try {
    const accessToken = await getAccessToken();
    const sourceInvoice = await getSourceInvoice(accessToken);
    const duplicatedInvoice = await duplicateInvoice(
      accessToken,
      sourceInvoice
    );

    const endTime = new Date();
    const duration = endTime - startTime;

    console.log(`[SUCCESS] 月次請求書複製処理完了: ${endTime.toISOString()}`);
    console.log(`[INFO] 処理時間: ${duration}ms`);

    return duplicatedInvoice;
  } catch (error) {
    console.error(
      "[ERROR] 月次請求書複製処理でエラーが発生しました:",
      error.message
    );
    process.exit(1);
  }
}

async function main() {
  // GCSからトークンを読み込み（Cloud Run Jobs環境）
  await initializeRefreshToken();

  // 必要な環境変数チェック
  if (!REFRESH_TOKEN) {
    console.error("[ERROR] REFRESH_TOKENが設定されていません。");
    console.error("[INFO] ローカル環境: .envファイルを確認してください");
    console.error(
      "[INFO] Cloud Run Jobs: GCSにrefresh-token.txtを配置してください"
    );
    process.exit(1);
  }
  if (!SOURCE_INVOICE_ID) {
    console.error(
      "[ERROR] SOURCE_INVOICE_IDが設定されていません。.envファイルを確認してください。"
    );
    process.exit(1);
  }

  // 月次請求書複製を実行
  await duplicateMonthlyInvoice();
}

main();
