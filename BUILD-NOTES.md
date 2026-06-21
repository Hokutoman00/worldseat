# BUILD-NOTES — H0 WorldSeat（一次情報・実行レシピ）
出所: docs.aws.amazon.com/aurora-dsql（WebFetch/Search 2026-06-20）

## Aurora DSQL マルチリージョン作成フロー（witness region 方式）
1. リージョンA(us-east-1)でクラスタ作成（witness=us-west-2）:
   `aws dsql create-cluster --region us-east-1 --multi-region-properties '{"witnessRegion":"us-west-2"}'`
   → 状態 **PENDING_SETUP**（peer ARN を設定するまで PENDING）
2. リージョンB(us-east-2)で同 witness のクラスタ作成
3. 両クラスタを peer ARN で相互更新（`dsql:AddPeerCluster` 権限が peer ARN ごとに必要）→ 両者 ACTIVE
4. 接続: 各 regional endpoint へ。witness region には endpoint 無し。
5. 認証: IAM 認証トークン（DbConnectAdmin）→ PostgreSQL wire protocol（psql / pg ドライバ）で接続。port 5432。

## 必要 IAM 権限（現状 Bedrock のみ → 追加要）
- dsql:CreateCluster / dsql:GetCluster / dsql:UpdateCluster / dsql:AddPeerCluster / dsql:DeleteCluster / dsql:ListClusters
- dsql:DbConnect / dsql:DbConnectAdmin（接続トークン）
- DynamoDB: dynamodb:* （naive 経路・Global Tables: CreateTable, CreateGlobalTable/UpdateTable で replica 追加, PutItem, GetItem, Query）
- 付与手段: root コンソール or IAM admin で IAM user にポリシーアタッチ（自アカウント内＝in-scope）

## DSQL の整合性挙動（テーゼの技術的根拠・要 live 実証）
- 強整合・OCC（Optimistic Concurrency Control）。並行で同一行に衝突する commit は一方が成功・他は OC 例外 → アプリ側で retry。
- → 同一席への並行 INSERT/UPDATE は一席だけ成立。oversold=0。**着手直後に実機で実証してから主張**（穴B/RC-2）。

## naive 対比（DynamoDB Global Tables）
- マルチリージョン・結果整合・last-writer-wins。read-then-write の並行はどちらも「空席」を読み二重書込 → oversold>0。
- シム化する場合は honesty guard ラベル必須。

## リージョン選定
- 書込2拠点: us-east-1 + us-east-2、witness: us-west-2（全て利用可・クレジット内）。
- UI のリージョン名は実デプロイ名で表示（honesty guard）。「世界同時」framing は2リージョンでも point 証明可。

## 証跡スクショ（提出物・honesty guard 検証済み 2026-06-20）
- `docs/architecture.png` — アーキ図（client→Vercel→Route Handlers→DSQL|DynamoDB GT + Witness）。
- `docs/aws-dsql-us-east-1.png` — DSQL クラスタ `grt3rxmuculbo3vip373w22rv4` アクティブ・ピア us-east-2・witness us-west-2。
- `docs/aws-dynamodb-globaltable.png` — seats_naive グローバルテーブル レプリカ(2) us-east-1+us-east-2 アクティブ・結果整合性・v2019.11.21。
- **RC-2 解消メモ**: DynamoDB テーブル一覧の「レプリケーションリージョン」列は "1 リージョン" と表示されたが、live CLI（`describe_table`）は両テーブル `Replicas=[us-east-2 ACTIVE]`（us-east-2 視点では us-east-1 ACTIVE）= **本物の2リージョン active-active**。一覧列の表示は誤解を招くため不採用、グローバルテーブルタブの正確な表示を採用。live CLI を canonical とする（L22）。
