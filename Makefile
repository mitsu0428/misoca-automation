IMAGE_NAME=misoca-app
CONTAINER_NAME=misoca-app-container

build:
	docker build -t $(IMAGE_NAME) .

# ローカル実行（.env永続化対応）
run:
	docker run --env-file .env -v $(PWD)/.env:/app/.env --name $(CONTAINER_NAME) --rm $(IMAGE_NAME)

# Cloud Run Jobs用（GCS自動連携）
run-cloud:
	docker run --env-file .env -e NODE_ENV=production --name $(CONTAINER_NAME) --rm $(IMAGE_NAME)

stop:
	-docker stop $(CONTAINER_NAME)

.PHONY: build run run-cloud stop
