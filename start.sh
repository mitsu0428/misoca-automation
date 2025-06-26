#!/bin/sh
set -e

echo "Misoca月次請求書複製バッチ開始: $(date)"
MODE=duplicate node batch.js
echo "Misoca月次請求書複製バッチ完了: $(date)"
