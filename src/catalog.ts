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
  // [미확인] 로그 필드 이름은 vector 설정(namespace·pod·container 스트림 필드) 기준이다. 실제 로그로 S16에서 확인한다.
  { id: 'homelab-bot-logs', service: 'homelab-bot', datasource: 'victorialogs', namespace: 'app-homelab-bot', kind: 'logs',
    query: '{namespace="app-homelab-bot"}', maxWindowSeconds: 3600, maxRows: 100, maxBytes: 65536 },
]);
// Kubernetes transport가 읽을 수 있는 Argo CD Application 이름. argocd 템플릿의 query(앱 이름)만이다.
export const ARGOCD_APPLICATIONS: readonly string[] = Object.freeze(TEMPLATES.filter(t => t.datasource === 'argocd').map(t => t.query));
