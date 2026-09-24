# 部署与运维

## 健康检查

- API 存活：`GET /health/live`
- API 就绪：`GET /health/ready`
- PostgreSQL：`pg_isready`
- Redis：`redis-cli ping`
- MinIO：`mc ready local`
- ClamAV：`clamdcheck.sh`

## 关键监控

- API 错误率、p50/p95/p99 延迟。
- PostgreSQL 连接数、慢查询和磁盘使用率。
- Redis 内存、BullMQ 等待任务和失败任务。
- `media_assets` 中 `processing` 或 `failed` 数量，以及 `processing_attempts` 的分布。
- `manual_review` 媒体队列长度；`privacy_report.detector = 'degraded'` 的数量表示隐私检测器正在降级。
- 检测器降级事件（审计动作 `media.privacy_degraded_to_manual_review`）和站内通知 `media_detector_degraded`；持续出现说明检测器不可用，应先排查检测器而不是放行媒体。
- `failure_code = 'QUEUE_UNAVAILABLE_PENDING_RECOVERY'` 的媒体数量（API 入队失败、等待 Worker 补入队）。
- `pending` 内容与评论队列长度。
- outbox `pending`、`failed` 数量。
- `delete_after <= now()` 的原图数量。
- 公开桶中是否存在未被数据库引用的对象。

## 备份

- PostgreSQL 每日全量备份并保留 WAL 或等价连续归档。
- MinIO 启用版本化和跨盘/跨区域容灾时，分别备份隔离桶和公开桶。
- `.env.production` 和密钥应保存在密钥管理系统，不进入镜像或仓库。
- 每季度执行一次恢复演练，验证数据库、公开媒体和迁移记录。

## 发布

1. 构建并锁定 API、Worker、Web 镜像。
2. 备份数据库。
3. 执行一次 `migrate` 容器。
4. 启动新 API 和 Worker。
5. 验证就绪检查、登录、地图查询和媒体处理。
6. 再切换 Caddy 流量。
7. 保留上一版本镜像用于回滚。

## 隐私事件

发现未模糊媒体或原图泄露时：

1. 立即停止相关媒体发布并删除公开对象。
2. 暂停媒体 Worker，防止继续复制到公开桶。
3. 根据对象访问日志确认影响范围。
4. 修复处理管线并执行全量扫描。
5. 删除或隔离受影响对象。
6. 记录事故、根因、修复和回归测试。
7. 按法律与运营要求通知用户。

## 数据保留

- 成功处理原图：24 小时。
- 失败处理原图：最多 7 天。
- 邮箱验证令牌：24 小时。
- 密码重置令牌：30 分钟。
- 过期刷新令牌：30 天清理。
- 账号删除冷静期：30 天。
- 审计与审核记录：默认 180 天，生产可按法务要求延长。
