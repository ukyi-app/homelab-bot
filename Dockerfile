# 봇 이미지 계약(homelab 공유 차트와 app-build, 템플릿 homelab-app-template의 Dockerfile을 Node로 옮김):
# - amd64 단일 빌드. app-build가 --platform linux/amd64로 부른다. codex는 npm의 linux-x64 패키지가 들어간다.
# - test 단계가 있어야 한다. app-build가 --target test로 시험(npm ci → npm run check → npm test)을 돌린다.
# - 이미지 하나를 게시 서버와 작업자가 함께 쓴다(D2, 사용자 2026-10-30). 기본 CMD는 게시 서버이고,
#   sandbox 작업자는 command를 ["node", "dist/src/worker-main.js"]로 바꾼다. ENTRYPOINT는 비워 두어 command가 그대로 돈다.
# - 비root uid 65532(공유 차트 runAsUser). sandbox 작업자는 uid 10001로 돈다. 그래서 파일은 root 소유·누구나 읽기로 둔다.
# - 루트 파일시스템은 읽기 전용이다. 쓰기는 /tmp(emptyDir)와 작업자의 영속 공간(PVC)만 된다.
# - 기반 이미지는 digest로 고정하고 Renovate가 올린다. 두 FROM은 같은 Node 버전을 따라간다(.node-version, package.json engines).

# 시험·빌드 단계는 git·python3이 있는 full 이미지다. 작업 레인 시험이 git init과 non-dumpable 자식(python3)을 띄운다.
FROM docker.io/library/node:24.22.0-trixie@sha256:03795b45b3153ccaf7459e36c09d4e7ad6bdc08c5c2c2df1fce7e9f465c9103f AS deps
WORKDIR /app
# 시험은 비root(node, uid 1000)로 돈다. root면 같은 UID 프로세스 확인·파일 권한을 보는 시험이 실제 배치와 다르게 돈다.
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS test
COPY --chown=node:node . .
RUN npm run check && npm test

FROM deps AS runtime
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
# 실행 의존성만 남긴다(codex 포함, package.json dependencies). 다른 UID가 읽고 실행하게 권한을 맞춘다.
RUN npm run build \
  && npm prune --omit=dev \
  && chmod -R a+rX,go-w node_modules dist

FROM docker.io/library/node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c
WORKDIR /app
COPY --from=runtime --chown=root:root /app/node_modules ./node_modules
COPY --from=runtime --chown=root:root /app/dist/src ./dist/src
COPY --from=runtime --chown=root:root /app/package.json ./
# 게시 서버 마이그레이션이 dist/src/database.js 기준 ../../migrations를 읽는다.
COPY --chown=root:root migrations ./migrations
# codex는 npm 래퍼(node 프로세스 하나 더)가 아니라 실제 실행 파일을 쓴다. 실행 파일은 자기 위치의 codex-package.json으로
# 번들(bwrap, rg)을 찾으므로 심링크로 둔다. 작업자는 /usr/local/bin/codex를 부르고 기동 때 버전을 다시 확인한다.
# 빌드 확인은 빈 /tmp를 HOME·CODEX_HOME으로 줘서 이미지에 Codex 파일을 남기지 않는다.
RUN ln -s /app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex /usr/local/bin/codex \
  && test "$(env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp CODEX_HOME=/tmp codex --version 2>/dev/null)" = "codex-cli 0.163.0" \
  && test -z "$(ls -A /tmp)"
USER 65532:65532
EXPOSE 8080 8081
ENTRYPOINT []
CMD ["node", "dist/src/main.js"]
