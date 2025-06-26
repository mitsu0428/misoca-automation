require("dotenv").config();

const express = require("express");
const axios = require("axios");
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

app.get("/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const tokenRes = await axios.post(
      "https://app.misoca.jp/oauth2/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
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
      }
    );

    res.send(`
      <h1>アクセストークン取得成功！</h1>
      <pre>${JSON.stringify(tokenRes.data, null, 2)}</pre>
    `);
  } catch (error) {
    console.error("Token error:", error.response?.data || error.message);
    res.send(
      `<h1>エラー発生</h1><pre>${JSON.stringify(
        error.response?.data || error.message,
        null,
        2
      )}</pre>`
    );
  }
});

app.listen(3000, () => {
  console.log("サーバー起動中: http://localhost:3000");
});
