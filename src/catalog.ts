import type { QueryTemplate, Service } from './read.js';

// 읽기 서비스·질의 템플릿은 코드에 둔다(공개 가능한 값만). 어떤 서비스를 실제로 열지는 런타임 정책의
// services(Infisical)가 정한다. 새 서비스는 이 목록과 정책 둘 다에 넣어야 읽힌다.
// datasource는 transport 경로 이름이다: kubernetes(SA bot-reader, Deployment·StatefulSet),
// argocd(같은 SA로 Kubernetes API의 Argo CD Application CR, D9), Grafana 데이터소스 uid
// victoriametrics·victorialogs(platform/observability/stack/grafana/datasources.yaml).
export const GRAFANA_DATASOURCES = Object.freeze({ victoriametrics: 'metrics', victorialogs: 'logs' } as const);
export const SERVICES: readonly Service[] = Object.freeze([
  { id: 'homelab-bot', repository: 'ukyi-app/homelab-bot', namespace: 'app-homelab-bot', deployment: 'homelab-bot',
    internalDomain: null, externalDomain: null, documentation: ['docs/ai-bot/ARCHITECTURE.md'] },
]);
export const TEMPLATES: readonly QueryTemplate[] = Object.freeze([
  { id: 'homelab-bot-deployment', service: 'homelab-bot', datasource: 'kubernetes', namespace: 'app-homelab-bot', kind: 'status',
    query: 'deployment/homelab-bot', maxWindowSeconds: 300, maxRows: 1, maxBytes: 4096 },
  { id: 'homelab-bot-argocd', service: 'homelab-bot', datasource: 'argocd', namespace: 'app-homelab-bot', kind: 'status',
    query: 'homelab-bot', maxWindowSeconds: 300, maxRows: 1, maxBytes: 4096 },
  { id: 'homelab-bot-available', service: 'homelab-bot', datasource: 'victoriametrics', namespace: 'app-homelab-bot', kind: 'metrics',
    query: 'kube_deployment_status_replicas_available{namespace="app-homelab-bot",deployment="homelab-bot"}',
    maxWindowSeconds: 3600, maxRows: 10, maxBytes: 8192 },
  // 로그 스트림 필드는 {container, namespace, pod, stream}이라 namespace 스트림 선택자로 이 앱 로그만 고른다(실측).
  { id: 'homelab-bot-logs', service: 'homelab-bot', datasource: 'victorialogs', namespace: 'app-homelab-bot', kind: 'logs',
    query: '{namespace="app-homelab-bot"}', maxWindowSeconds: 3600, maxRows: 100, maxBytes: 65536 },
]);
// Kubernetes transport가 읽을 수 있는 Argo CD Application 이름. argocd 템플릿의 query(앱 이름)만이다.
export const ARGOCD_APPLICATIONS: readonly string[] = Object.freeze(TEMPLATES.filter(t => t.datasource === 'argocd').map(t => t.query));

// 병합 뒤 배포 읽기(T19 DEPLOY-01)의 정적 매핑이다. /read의 SERVICES·TEMPLATES와 따로 둔다. 여기 있어도 /read로 열리지 않고,
// 어느 저장소 ID를 어느 항목에 잇는지는 조립할 때 정책이 정한다. 항목만 있고 정책이 없으면 읽지 않는다.
export interface AppDeployTarget {
  kind: 'app'; service: string; repository: string; configRepository: string; imageFile: string; imageRepository: string;
  namespace: string; deployment: string; container: string; argoApplication: string; podApp: string;
}
// 이미지가 없는 설정 저장소다. noDeployPrefixes 밖을 바꾼 PR의 배포 영향은 이 매핑으로 판단하지 못한다.
export interface ConfigDeployTarget { kind: 'config'; service: string; repository: string; noDeployPrefixes: readonly string[] }
export type DeployTarget = AppDeployTarget | ConfigDeployTarget;
const CONFIG_REPOSITORY = 'ukyi-app/homelab';
// homelab 공유 차트 규칙(platform/charts/app, platform/appsets/apps): Application·릴리스·Deployment는 앱 이름, ns는 app-<앱>,
// 컨테이너는 app, 파드 selector는 homelab.ukyi.app/app=<앱>, 이미지는 ghcr.io/ukyi-app/<앱>. 차트가 다른 값을 거부한다.
const appTarget = (app: string): AppDeployTarget => Object.freeze({
  kind: 'app', service: app, repository: `ukyi-app/${app}`, configRepository: CONFIG_REPOSITORY, imageFile: `apps/${app}/image.yaml`,
  imageRepository: `ghcr.io/ukyi-app/${app}`, namespace: `app-${app}`, deployment: app, container: 'app', argoApplication: app, podApp: app,
});
export const DEPLOY_TARGETS: readonly DeployTarget[] = Object.freeze([
  appTarget('homelab-bot'),
  // homelab에 apps/homelab-smoke/가 생기기 전(H0)에는 deploy_config_unregistered로 막힌다.
  appTarget('homelab-smoke'),
  // 이 경로는 어떤 ApplicationSet·차트도 읽지 않아 클러스터에 닿지 않는다.
  Object.freeze({ kind: 'config', service: 'homelab', repository: CONFIG_REPOSITORY, noDeployPrefixes: Object.freeze(['docs/runbooks-public/']) }),
]);
