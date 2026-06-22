# Backend Local Postgres

本地开发可以用仓库里的 `docker-compose.yml` 启一个 Postgres，用于验证 backend-owned analysis 的 schema。

## 启动数据库

```bash
docker compose up -d postgres
```

默认连接信息：

```text
host=127.0.0.1
port=5432
database=hotel_review_ai
user=hotel_review_ai
password=hotel_review_ai_dev
```

如果本机 `5432` 已被占用，可以覆盖本地端口：

```bash
POSTGRES_PORT=15432 docker compose up -d postgres
```

此时 DSN 里的端口也要同步改成 `15432`。

DSN：

```text
postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai
```

## 执行 migration

```bash
psql "postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai" \
  -f server/migrations/001_backend_owned_analysis.sql
```

如果本机没有 `psql`，可以通过容器执行：

```bash
docker compose exec -T postgres psql -U hotel_review_ai -d hotel_review_ai \
  -f /dev/stdin < server/migrations/001_backend_owned_analysis.sql
```

## 快速检查

```bash
docker compose exec postgres psql -U hotel_review_ai -d hotel_review_ai \
  -c "\\dt"
```
