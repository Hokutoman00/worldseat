// Central runtime config. Endpoints/regions come from Vercel env vars (set at deploy).
// Defaults match the provisioned clusters so local `next dev` works with the same AWS creds.
export const DSQL = {
  hostA: process.env.DSQL_HOST_A || 'grt3rxmuculbo3vip373w22rv4.dsql.us-east-1.on.aws',
  regionA: process.env.DSQL_REGION_A || 'us-east-1',
  hostB: process.env.DSQL_HOST_B || 'lzt3rxh6i6xpbtpzlteipk4pja.dsql.us-east-2.on.aws',
  regionB: process.env.DSQL_REGION_B || 'us-east-2',
  witnessRegion: process.env.DSQL_WITNESS || 'us-west-2',
};

export const DDB = {
  regionA: process.env.DDB_REGION_A || 'us-east-1',
  regionB: process.env.DDB_REGION_B || 'us-east-2',
  seatsTable: process.env.DDB_SEATS_TABLE || 'seats_naive',
  salesTable: process.env.DDB_SALES_TABLE || 'sales_naive',
};

export function awsCreds() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.WS_AWS_KEY;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.WS_AWS_SECRET;
  if (!accessKeyId || !secretAccessKey) return undefined; // fall back to default provider chain
  return { accessKeyId, secretAccessKey };
}

// Venue layout for the ticketing spine: 8 rows (A–H) × 12 seats = 96.
export const VENUE = { rows: 'ABCDEFGH'.split(''), cols: 12 };
export function allSeatIds(): string[] {
  const ids: string[] = [];
  for (const r of VENUE.rows) for (let c = 1; c <= VENUE.cols; c++) ids.push(`${r}${c}`);
  return ids;
}
