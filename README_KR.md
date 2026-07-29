# VtAtlas

[English](README.md) | [한국어](README_KR.md)

VtAtlas는 실행 중인 [Vitess](https://vitess.io/) 환경을 위한 토폴로지 탐색기이자 보호 절차가 있는 운영 콘솔입니다. Vitess가 실제로 보고하는 토폴로지를 수집하여 논리 구조, 물리 구조, 요청 경로, 복제 관계를 로컬 웹 UI로 보여 줍니다. Viewer 모드는 읽기 전용이며, 선택 사항인 DBA 모드는 로컬 Operator API, 작업별 승인, 감사 로그, 제한된 VTAdmin 쓰기 RBAC를 통해서만 변경 작업을 수행합니다.

이 저장소에는 애플리케이션 소스와 범용 예제만 포함됩니다. VtAtlas를 개발한 환경의 토폴로지 스냅샷, 데이터베이스 데이터, 인증 정보 또는 실제 설정은 포함하지 않습니다.

## 주요 기능

- 논리 구조, 물리 구조, 요청 경로, 복제 관계를 위에서 아래로 고정 배치
- 이름이 같은 Keyspace도 겹치지 않도록 Cluster별 독립 레인 구성
- 노드 더블클릭 집중 탐색, 다단계 관계 추적, 이전 관계 복귀, 화면 이동, 확대·축소 및 화면 맞춤
- 노샤딩 Keyspace를 불필요한 `Shard 0` 박스 없이 별도의 청록색 Keyspace 노드로 표시
- 전용 오류 센터와 상단 빨간 상태 바의 오류 바로가기
- 설치됐지만 실행되지 않은 VTOrc, VTAdmin, `mysqlctld` 표시
- Cluster별 여러 vtctld 및 VTGate endpoint 등록
- VTAdmin 23.0.3에 등록된 HTTP route를 모두 제공하는 VtAtlas 운영 콘솔: Viewer 35개, DBA 41개 기능
- 읽기 전용/제한 쓰기 VTAdmin 프로세스 분리, DBA 세션, 실제 대상 사전검증, 일회성 승인, 정확한 확인 문구, 로컬 JSONL 감사 로그
- 마지막 정상 상태 보존: Cluster 조회가 타임아웃되어도 기존 노드를 삭제하지 않고 장애 상태로 유지

상태 색상은 다음 의미로 일관되게 사용합니다.

| 색상 | 의미 |
| --- | --- |
| 초록색 | 정상 |
| 노란색 | 성능 저하, Replica 장애 또는 복제 성능 저하 |
| 빨간색 | Primary 부재 또는 Cluster 연결 불가 등 서비스 영향 장애 |
| 회색 | 확인 불가, Maintenance 또는 설치됐지만 실행되지 않음 |

## 요구 사항

- Linux 또는 WSL
- Node.js 20 이상
- 접근 가능한 `vtctld` gRPC endpoint
- Vitess 설치본의 `vtctldclient`
- 로컬 listen port 조사를 위한 `net-tools`의 `netstat`
- 선택 사항: Vitess `vtadmin` 바이너리와 빌드된 VTAdmin Web 파일

VtAtlas는 별도의 타사 npm 런타임 의존성이 없습니다.

## 빠른 시작

```bash
git clone https://github.com/ohjinsol77/VtAtlas.git
cd VtAtlas
cp config.example.env config.env
```

로컬 Vitess 설치 환경에 맞게 `config.env`를 수정합니다. 최소한 다음 값은 반드시 확인하십시오.

```bash
VTV_VTCTLDCLIENT=/opt/vitess/current/bin/vtctldclient
VTV_VTCTLD_ADDRESS=127.0.0.1:15999
```

설정을 적용하고 소스를 검사한 뒤 UI를 실행합니다.

```bash
set -a
. ./config.env
set +a
npm run check
npm test
npm start
```

[http://localhost:17888](http://localhost:17888)로 접속합니다. 운영 콘솔은 `/admin.html`, 오류 센터는 `/errors.html`, Cluster 등록 페이지는 `/servers.html`입니다.

`VTV_START_SCRIPT`는 선택 사항입니다. 이 값을 지정하면 VtAtlas가 시작 스크립트에서 비밀값이 아닌 실행 설정 힌트를 읽습니다. 토폴로지 관계 자체는 계속 Vitess의 라이브 API와 프로세스 정보로 확인합니다.

## 다중 클러스터 구성

기본 수집기는 로컬 Cluster를 조회할 때 `vtctldclient`를 사용합니다. 추가 Cluster는 공식 VTAdmin API를 통해 통합합니다.

1. 최초 Cluster에 맞게 `vtadmin/clusters.json`과 `vtadmin/discovery-local.json`을 수정합니다.
2. 읽기 전용 VTAdmin API를 실행합니다.

   ```bash
   node vtadmin/launcher.mjs
   ```

3. 다른 프로세스에서 선택 사항인 공식 VTAdmin Web 화면을 실행합니다.

   ```bash
   node vtadmin/web-server.mjs
   ```

4. VtAtlas를 시작하기 전에 `VTV_VTADMIN_API=http://127.0.0.1:14200`을 설정합니다.
5. `http://localhost:17888/servers.html`에서 추가 Cluster를 등록합니다.

Cluster 하나에 여러 vtctld 및 VTGate endpoint를 등록할 수 있습니다. `fqdn`은 HTTP endpoint이고 `hostname`은 gRPC endpoint입니다.

```json
{
  "id": "production-a",
  "name": "Production A",
  "enabled": true,
  "tabletFqdnTemplate": "http://{{ .Tablet.Hostname }}:15{{ .Tablet.Alias.Uid }}",
  "discovery": {
    "vtctlds": [
      {
        "host": {
          "fqdn": "control-a.example.net:15000",
          "hostname": "control-a.example.net:15999"
        }
      }
    ],
    "vtgates": [
      {
        "host": {
          "fqdn": "gateway-a.example.net:15001",
          "hostname": "gateway-a.example.net:15991"
        }
      }
    ]
  }
}
```

비활성 상태의 `vtadmin/managed-clusters.example.json` 예제를 `var/managed-clusters.json`으로 복사해 사용할 수도 있습니다. 실행할 때 호스트 주소가 바뀌는 환경에서는 endpoint에 `{{HOST_IP}}:port`를 사용하고 `VTA_HOST_IP`로 주소를 지정할 수 있습니다.

런처는 관리 대상 등록 파일을 감시합니다. 서버 등록 정보를 저장하면 VTAdmin이 정상 종료 후 자동으로 다시 시작되며, 원격 Vitess Cluster의 구성은 변경하지 않습니다.

## Viewer 모드와 DBA 모드

Viewer 모드는 읽기 허용 목록만 읽기 전용 VTAdmin API로 전달합니다. 선택 사항인 DBA 모드는 다음과 같이 별도의 프로세스 경계를 사용합니다.

```text
Viewer
  └─ VtAtlas :17888
       └─ 읽기 작업 허용 목록
            └─ 읽기 전용 VTAdmin :14200

DBA
  └─ VtAtlas :17888
       └─ Operator API :17890
            ├─ 짧은 유효기간의 DBA 세션
            ├─ 실제 Cluster/Keyspace/Shard/Tablet 사전검증
            ├─ 일회성 승인 + 정확한 확인 문구
            ├─ 비밀값을 제거한 JSONL 감사 로그
            └─ 제한 쓰기 VTAdmin :14202
```

운영 콘솔은 인벤토리, 토폴로지, 상태·진단, 복제, HA, Tablet, Schema와 Online DDL, Workflow, VDiff, 트랜잭션, VExplain/VTExplain을 제공합니다.

| 구분 | DBA 작업 |
| --- | --- |
| 토폴로지 | Keyspace·Shard 생성/삭제, Tablet 삭제, Serving Graph 재구성, Keyspace Cell 제거 |
| HA | Planned/Emergency Failover, 외부 승격 반영 |
| Tablet | Read-only/Read-write, 상태 갱신, Schema Reload |
| 복제 | Start/Stop Replication, Replication Source 갱신 |
| 검증 | Cluster·Keyspace·Shard·Schema·버전 검증 |
| Schema | Reload, Schema/Online DDL 적용, Migration 취소·정리·완료·실행·재시도 |
| Workflow | Start/Stop, Materialize, MoveTables, Reshard, Traffic 전환, 완료·삭제, VDiff |
| 트랜잭션 | 미해결 분산 트랜잭션 종료 |

DBA 사용자 **인증은 아직 구현하지 않았습니다**. 현재 버전은 localhost 개발/운영 경계로만 사용해야 합니다. 내부망에 노출하기 전 `operator/auth.mjs`를 사내 인증·승인 시스템과 연결하고, Operator와 두 VTAdmin port는 외부에 노출하지 말고, VtAtlas 앞단에 인증 TLS와 네트워크 ACL을 적용하십시오.

## 데이터 흐름

```text
브라우저
  └─ VtAtlas :17888
       ├─ vtctldclient를 통한 로컬 vtctld gRPC 조회
       ├─ 로컬 프로세스, listen port 및 debug endpoint 조회
       ├─ 읽기 전용 VTAdmin API :14200
       │    ├─ Cluster A의 vtctld / VTGate
       │    ├─ Cluster B의 vtctld / VTGate
       │    └─ 추가로 등록한 Cluster
       └─ 선택 사항인 Operator API :17890
            └─ 제한 쓰기 VTAdmin API :14202
```

VtAtlas는 MySQL에 직접 연결하지 않습니다. Viewer 모드는 Vitess에 데이터를 쓰지 않습니다. 승인된 DBA 작업만 별도의 제한 쓰기 VTAdmin을 거쳐 vtctld에 전달합니다. 애플리케이션 전용 런타임 파일은 `var/last-good.json`, `var/managed-clusters.json`, `var/operator-audit.jsonl`입니다.

## API

| Method | Path | 기능 |
| --- | --- | --- |
| `GET` | `/api/health` | VtAtlas 프로세스 상태 |
| `GET` | `/api/topology` | 가장 최근에 정규화한 토폴로지 |
| `POST` | `/api/refresh` | 읽기 전용 즉시 재수집 |
| `GET` | `/api/servers` | 기본 및 관리 대상 Cluster 목록 |
| `POST` | `/api/servers` | 모니터링 대상 등록 |
| `PUT` | `/api/servers/:id` | 모니터링 대상 수정 |
| `DELETE` | `/api/servers/:id` | 모니터링 대상 등록 해제 |
| `GET` | `/api/raw/:sourceId` | 비밀값이 제거된 원본 응답 |
| `GET` | `/api/configuration` | 비밀값이 없는 실행 설정 |
| `GET` | `/api/admin/catalog` | Viewer VTAdmin 기능 목록 |
| `POST` | `/api/admin/read` | 허용된 Viewer 기능 실행 |
| `GET` | `/api/operator/catalog` | DBA 기능 목록 |
| `GET/POST/DELETE` | `/api/operator/session` | DBA 모드 확인·진입·종료 |
| `POST` | `/api/operator/prepare` | DBA 대상 검증과 일회성 승인 생성 |
| `POST` | `/api/operator/execute` | 승인된 작업 실행 |
| `GET` | `/api/operator/audit` | 최근 감사 이벤트 조회 |

## systemd

`deploy/`에 범용 systemd Unit이 포함되어 있습니다. 기본 Unit은 저장소가 `/opt/vtatlas`에 설치되고 `vitess` 사용자가 실행하는 구성을 사용합니다.

```bash
sudo install -d -o vitess -g vitess /opt/vtatlas /opt/vtatlas/var
sudo install -d -m 0750 /etc/vtatlas
sudo cp config.example.env /etc/vtatlas/vtatlas.env
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vtatlas.service
```

소스를 `/opt/vtatlas`에 설치하거나 clone한 후 `/etc/vtatlas/vtatlas.env`를 수정합니다. 다중 Cluster Viewer 기능에는 읽기 전용 VTAdmin 서비스를 활성화합니다.

```bash
sudo systemctl enable --now vtatlas-vtadmin-api.service
sudo systemctl restart vtatlas.service
```

DBA 모드를 활성화하려면 환경 파일에 `VTV_OPERATOR_API=http://127.0.0.1:17890`을 설정하고 제한 쓰기 VTAdmin과 Operator 서비스를 별도로 실행합니다.

```bash
sudo systemctl enable --now vtatlas-vtadmin-operator.service
sudo systemctl enable --now vtatlas-operator.service
sudo systemctl restart vtatlas.service
```

기존 공식 VTAdmin Web 화면은 필요한 경우에만 별도로 실행합니다.

```bash
sudo systemctl enable --now vtatlas-vtadmin-web.service
```

다른 설치 경로나 서비스 계정을 사용한다면 Unit 파일의 경로와 사용자를 수정하십시오.

## 보안 구조

- 모든 웹 서비스는 기본적으로 loopback 주소에만 bind합니다.
- Viewer 요청과 DBA 요청은 서로 다른 endpoint 허용 목록과 VTAdmin 프로세스를 사용합니다.
- Viewer VTAdmin은 읽기 전용 RBAC를 사용합니다. Operator VTAdmin은 전체 쓰기 권한 대신 기능별로 명시된 제한 쓰기 RBAC만 사용합니다.
- Operator API는 의도 확인 헤더, 유효기간이 짧은 DBA 세션, 현재 대상 사전검증, 일회성 승인 토큰, 작업·대상이 포함된 정확한 확인 문구를 요구합니다.
- 외부 명령은 Shell을 거치지 않고 고정된 실행 파일과 인자 배열로 실행합니다.
- 모든 명령과 HTTP 요청에 timeout과 응답 크기 제한을 적용합니다.
- Password, Token, Secret, Credential 및 Private Key 관련 필드를 제거합니다.
- Cluster 등록 정보 변경은 same-origin JSON 요청과 명시적인 의도 확인 헤더를 요구합니다.
- Operator 이벤트는 mode 0600 JSONL 감사 로그에 추가합니다.
- 런타임 상태 파일과 감사 로그는 Git에서 제외합니다.

VtAtlas에는 아직 사용자 인증 기능이 없습니다. `DBA MODE` 입력은 안전 확인 장치이며 사용자 신원 확인이 아닙니다. 내부망에서 사용하려면 인증 경계를 먼저 구현하고, 14200·14202·17890 port는 loopback에 유지하며, 메인 VtAtlas 서비스만 인증·TLS·네트워크 ACL이 적용된 Reverse Proxy를 통해 노출하십시오.

## 테스트

```bash
npm run check
npm test
```

테스트는 가상의 Cluster 이름과 문서용 IP 대역만 사용하므로 실제 Vitess Cluster가 없어도 실행할 수 있습니다.

테스트에는 v23.0.3 전체 route 목록, 요청·경로 검증, 응답 크기 제한과 비밀값 제거, 세션·승인 강제, 승인 후 요청 불변성, 감사 로그, 노샤딩, 로컬 샤딩, 원격 샤딩 시나리오가 포함됩니다.

실제 환경 구성 후 다음 안전 점검 스크립트로 Viewer 조회, 사전검증, 발견된 모든 노샤딩/로컬 샤딩/원격 샤딩 Shard, 감사 로그, 작업 전후 토폴로지 동일 여부를 확인할 수 있습니다. 기본 실행은 사전검증에서 멈추며, 옵션을 주면 변경 작업이 아닌 `ValidateShard`만 실제 실행합니다.

```bash
node scripts/live-operator-probe.mjs
node scripts/live-operator-probe.mjs --execute-validations
```

## 라이선스

Apache License 2.0을 따릅니다. Vitess와 VTAdmin은 Vitess 커뮤니티의 프로젝트이며, VtAtlas는 독립적인 시각화 도구입니다.
