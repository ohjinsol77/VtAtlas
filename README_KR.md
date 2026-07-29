# VtAtlas

[English](README.md) | [한국어](README_KR.md)

VtAtlas는 실행 중인 [Vitess](https://vitess.io/) 환경을 위한 읽기 전용 토폴로지 탐색기입니다. Vitess가 실제로 보고하는 토폴로지를 수집하여 논리 구조, 물리 구조, 요청 경로, 복제 관계를 로컬 웹 UI로 보여 줍니다.

이 저장소에는 애플리케이션 소스와 범용 예제만 포함됩니다. VtAtlas를 개발한 환경의 토폴로지 스냅샷, 데이터베이스 데이터, 인증 정보 또는 실제 설정은 포함하지 않습니다.

## 주요 기능

- 논리 구조, 물리 구조, 요청 경로, 복제 관계를 위에서 아래로 고정 배치
- 이름이 같은 Keyspace도 겹치지 않도록 Cluster별 독립 레인 구성
- 노드 더블클릭 집중 탐색, 다단계 관계 추적, 이전 관계 복귀, 화면 이동, 확대·축소 및 화면 맞춤
- 노샤딩 Keyspace를 불필요한 `Shard 0` 박스 없이 별도의 청록색 Keyspace 노드로 표시
- 전용 오류 센터와 상단 빨간 상태 바의 오류 바로가기
- 설치됐지만 실행되지 않은 VTOrc, VTAdmin, `mysqlctld` 표시
- Cluster별 여러 vtctld 및 VTGate endpoint 등록
- 공식 VTAdmin API와 Web UI의 선택적 읽기 전용 연동
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

[http://localhost:17888](http://localhost:17888)로 접속합니다. 오류 센터는 `/errors.html`, Cluster 등록 페이지는 `/servers.html`입니다.

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

## 데이터 흐름

```text
브라우저
  └─ VtAtlas :17888
       ├─ vtctldclient를 통한 로컬 vtctld gRPC 조회
       ├─ 로컬 프로세스, listen port 및 debug endpoint 조회
       └─ 선택 사항인 VTAdmin API :14200
            ├─ Cluster A의 vtctld / VTGate
            ├─ Cluster B의 vtctld / VTGate
            └─ 추가로 등록한 Cluster
```

VtAtlas는 MySQL에 직접 연결하거나 etcd 같은 Topology Service에 데이터를 쓰지 않습니다. 애플리케이션 전용 런타임 파일인 `var/last-good.json`과 `var/managed-clusters.json`만 기록합니다.

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

소스를 `/opt/vtatlas`에 설치하거나 clone한 후 `/etc/vtatlas/vtatlas.env`를 수정합니다. 다중 Cluster 기능이나 공식 VTAdmin UI가 필요하면 두 개의 선택적 VTAdmin 서비스를 활성화합니다.

```bash
sudo systemctl enable --now vtatlas-vtadmin-api.service
sudo systemctl enable --now vtatlas-vtadmin-web.service
sudo systemctl restart vtatlas.service
```

다른 설치 경로나 서비스 계정을 사용한다면 Unit 파일의 경로와 사용자를 수정하십시오.

## 보안 구조

- 모든 웹 서비스는 기본적으로 loopback 주소에만 bind합니다.
- VTAdmin은 서버 측 읽기 전용 RBAC와 Web 읽기 전용 모드를 함께 사용합니다.
- VtAtlas에는 Reparent, VSchema 변경, Workflow 변경 또는 SQL 쓰기 기능이 없습니다.
- 외부 명령은 Shell을 거치지 않고 고정된 실행 파일과 인자 배열로 실행합니다.
- 모든 명령과 HTTP 조회에 timeout을 적용합니다.
- Password, Token, Secret, Credential 및 Private Key 관련 필드를 제거합니다.
- Cluster 등록 정보 변경은 same-origin JSON 요청과 명시적인 의도 확인 헤더를 요구합니다.
- 런타임 상태 파일은 Git에서 제외합니다.

VtAtlas 자체에는 사용자 인증 기능이 없습니다. 내부망에서 사용할 때도 서비스는 loopback에 유지하고, 인증과 TLS 및 네트워크 ACL을 적용한 Reverse Proxy를 앞에 배치하십시오.

## 테스트

```bash
npm run check
npm test
```

테스트는 가상의 Cluster 이름과 문서용 IP 대역만 사용하므로 실제 Vitess Cluster가 없어도 실행할 수 있습니다.

## 라이선스

Apache License 2.0을 따릅니다. Vitess와 VTAdmin은 Vitess 커뮤니티의 프로젝트이며, VtAtlas는 독립적인 시각화 도구입니다.
