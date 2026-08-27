# 设备润滑加注系统（云端第一版）

这是上一版手机演示界面的云端版本。

## 已实现

- 手机浏览器扫码访问
- 每台设备独立链接：`/e/SB001`
- 显示设备编号、名称、位置
- 显示上次加注时间和加注量
- 输入本次加注量
- 服务端自动记录时间
- 所有手机共享同一份 PostgreSQL 数据
- 加注历史记录
- CSV 导出
- 自动生成/打印每台设备二维码
- 不需要账号和密码
- API 写入限流
- 健康检查 `/health`

## 推荐的最简单部署：Render Blueprint

### 1. 把本目录上传到一个 Git 仓库

例如 GitHub 新建一个仓库，把本目录里的文件全部上传到仓库根目录。

### 2. 在 Render 创建 Blueprint

进入 Render Dashboard：

- New
- Blueprint
- 连接刚才的 Git 仓库
- Render 会自动读取根目录的 `render.yaml`
- 创建 `lubrication-web` Web Service
- 创建 `lubrication-db` PostgreSQL

数据库连接地址会通过 `DATABASE_URL` 自动给后端，不需要把密码写进代码。

### 3. 部署完成后

Render 会给你一个类似这样的公网 HTTPS 地址：

`https://lubrication-web-xxxx.onrender.com`

然后直接打开：

- 1号空压机：`https://你的地址/e/SB001`
- 2号空压机：`https://你的地址/e/SB002`
- 液压站：`https://你的地址/e/SB003`

二维码打印页：

- `https://你的地址/qr/SB001`
- `https://你的地址/qr/SB002`
- `https://你的地址/qr/SB003`

打印后贴到设备上即可。

## 自定义设备

第一版启动时自动创建三台演示设备。

要增加设备，可在 PostgreSQL 执行：

```sql
INSERT INTO devices(code, name, location)
VALUES ('SB004', '3号空压机', '二号车间');
```

随后：

- 扫码页：`/e/SB004`
- 二维码：`/qr/SB004`

## 换成其他 PostgreSQL 云数据库

程序只依赖标准 `DATABASE_URL`，所以也可以接 Neon、Supabase、Railway Postgres 等 PostgreSQL。

设置环境变量：

`DATABASE_URL=postgresql://...`

如果数据库要求应用端显式使用 TLS，可再设置：

`DATABASE_SSL=true`

服务器首次启动会自动建表。

## 重要说明

当前版本没有登录/密码，因此知道设备链接的人理论上都可以提交记录。适合先做厂内流程测试。
正式投入生产时建议下一步增加：

- 工人姓名/工号
- 管理员登录
- 提交记录不可修改、管理员可纠错
- 润滑油型号
- 设备加注周期
- 到期/超期提醒
- 数据备份
- 管理后台批量导入设备
