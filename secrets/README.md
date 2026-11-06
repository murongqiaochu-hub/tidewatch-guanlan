# 密钥文件目录（容器绑定挂载到 /run/secrets）。
#
# 这里只放两个普通文件，不要提交到仓库：
#   secrets/jwt                  JWT 签名密钥
#   secrets/admin-password       首次初始化空数据目录时的管理员引导密码
#
# 生成与权限（在仓库根目录执行）：
#   mkdir -p secrets && chmod 700 secrets
#   head -c 48 /dev/urandom | base64 | tr -d '\n' > secrets/jwt
#   head -c 24 /dev/urandom | base64 | tr -d '\n' > secrets/admin-password
#   chown 10001:10001 secrets/jwt secrets/admin-password
#   chmod 600 secrets/jwt secrets/admin-password
#
# 服务端会拒绝符号链接、非普通文件、带 group/other 权限位或为空的密钥文件。
