# Collaborative Pixel-Mask Service

显微图像掩膜的并行修订服务：标注员基于某个**基础修订号**提交行内半开区间
`[startCol, endCol)` 补丁；互不相交的修改自动接纳，迟到请求不会覆盖他人已确认
的像素。

## 合并语义

- 每个掩膜保存两份逐行 RLE：当前**标签**（0–255）与每像素的**最后写入修订号**。
- 补丁提交时携带 `baseRev`：
  - 目标像素中只要有任何一个自 `baseRev` 起被其他成功补丁写入过 → `409`，
    返回 `currentRev` 及按行排序、同行合并的冲突区间；本次请求不产生任何修改。
  - 否则补丁在**最新掩膜**上原子合并，`rev` 连续 +1（即使 `baseRev` 落后）。
- 每掩膜一把锁，串行化补丁提交，并发提交绝不丢失更新。
- 冲突检测先于写入（两阶段），部分重叠的补丁整体不生效。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/masks/events` | `type:"create"` 建全零掩膜；`type:"patch"` 提交补丁 |
| GET  | `/api/masks/{maskId}` | 尺寸、`currentRev`、规范化逐行 RLE |
| GET  | `/health` | 健康检查 |

创建请求：

```json
{"type": "create", "maskId": "slide-42", "rows": 1024, "cols": 1024}
```

补丁请求（区间半开、同一补丁内不得重叠）：

```json
{"type": "patch", "maskId": "slide-42", "baseRev": 0,
 "regions": [{"row": 3, "startCol": 10, "endCol": 20, "label": 255}]}
```

冲突响应：`409`，`{"error":"conflict","currentRev":N,"conflicts":[...]}`。
重名创建：`409`，`{"error":"mask_already_exists", ...}`。

## 运行

宿主机端口由环境变量 `APP_PORT` 配置（默认 8080）：

```bash
APP_PORT=9000 docker compose up --build
```

`verify` 是一次性服务：它等待 `app` 健康检查通过后，依次执行

1. `pytest` 单元/集成/属性测试；
2. 构建核对（应用包可导入）；
3. 真实 HTTP 不相交补丁合并冒烟（含 409 冲突与重名创建）；

随后自行退出，全部通过退出码为 0：

```bash
docker compose build
docker compose up verify          # 只看一次性校验结果
docker compose up app             # 常驻服务
```
