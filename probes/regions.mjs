// AzureMe Pulse: reachability of every public Azure region through its regional Azure Resource Manager endpoint.
// The metadata document is public, so no authentication is used. Coordinates are approximate and serve only the map.
// [location name, display name, city or state, latitude, longitude, geography]
export const REGIONS = [
  ['eastus', 'East US', 'Wirginia', 37.37, -79.82, 'am'],
  ['eastus2', 'East US 2', 'Wirginia', 36.67, -78.39, 'am'],
  ['centralus', 'Central US', 'Iowa', 41.59, -93.62, 'am'],
  ['northcentralus', 'North Central US', 'Illinois', 41.88, -87.63, 'am'],
  ['southcentralus', 'South Central US', 'Teksas', 29.42, -98.50, 'am'],
  ['westcentralus', 'West Central US', 'Wyoming', 41.14, -104.82, 'am'],
  ['westus', 'West US', 'Kalifornia', 37.78, -122.42, 'am'],
  ['westus2', 'West US 2', 'Waszyngton', 47.23, -119.85, 'am'],
  ['westus3', 'West US 3', 'Arizona', 33.45, -112.07, 'am'],
  ['canadacentral', 'Canada Central', 'Toronto', 43.65, -79.38, 'am'],
  ['canadaeast', 'Canada East', 'Quebec', 46.82, -71.22, 'am'],
  ['mexicocentral', 'Mexico Central', 'Querétaro', 20.59, -100.39, 'am'],
  ['brazilsouth', 'Brazil South', 'São Paulo', -23.55, -46.63, 'am'],
  ['chilecentral', 'Chile Central', 'Santiago', -33.45, -70.67, 'am'],
  ['northeurope', 'North Europe', 'Dublin', 53.35, -6.26, 'eu'],
  ['westeurope', 'West Europe', 'Amsterdam', 52.37, 4.90, 'eu'],
  ['uksouth', 'UK South', 'Londyn', 51.51, -0.13, 'eu'],
  ['ukwest', 'UK West', 'Cardiff', 51.48, -3.18, 'eu'],
  ['francecentral', 'France Central', 'Paryż', 48.86, 2.35, 'eu'],
  ['germanywestcentral', 'Germany West Central', 'Frankfurt', 50.11, 8.68, 'eu'],
  ['switzerlandnorth', 'Switzerland North', 'Zurych', 47.38, 8.54, 'eu'],
  ['norwayeast', 'Norway East', 'Oslo', 59.91, 10.75, 'eu'],
  ['swedencentral', 'Sweden Central', 'Gävle', 60.67, 17.14, 'eu'],
  ['polandcentral', 'Poland Central', 'Warszawa', 52.23, 21.01, 'eu'],
  ['italynorth', 'Italy North', 'Mediolan', 45.46, 9.19, 'eu'],
  ['spaincentral', 'Spain Central', 'Madryt', 40.42, -3.70, 'eu'],
  ['austriaeast', 'Austria East', 'Wiedeń', 48.21, 16.37, 'eu'],
  ['belgiumcentral', 'Belgium Central', 'Bruksela', 50.85, 4.35, 'eu'],
  ['denmarkeast', 'Denmark East', 'Kopenhaga', 55.68, 12.57, 'eu'],
  ['uaenorth', 'UAE North', 'Dubaj', 25.27, 55.30, 'mea'],
  ['qatarcentral', 'Qatar Central', 'Doha', 25.29, 51.53, 'mea'],
  ['israelcentral', 'Israel Central', 'Tel Awiw', 32.09, 34.78, 'mea'],
  ['southafricanorth', 'South Africa North', 'Johannesburg', -26.20, 28.05, 'mea'],
  ['eastasia', 'East Asia', 'Hongkong', 22.32, 114.17, 'ap'],
  ['southeastasia', 'Southeast Asia', 'Singapur', 1.35, 103.82, 'ap'],
  ['japaneast', 'Japan East', 'Tokio', 35.68, 139.69, 'ap'],
  ['japanwest', 'Japan West', 'Osaka', 34.69, 135.50, 'ap'],
  ['koreacentral', 'Korea Central', 'Seul', 37.57, 126.98, 'ap'],
  ['koreasouth', 'Korea South', 'Pusan', 35.18, 129.08, 'ap'],
  ['centralindia', 'Central India', 'Pune', 18.52, 73.86, 'ap'],
  ['southindia', 'South India', 'Ćennaj', 13.08, 80.27, 'ap'],
  ['westindia', 'West India', 'Mumbaj', 19.08, 72.88, 'ap'],
  ['australiaeast', 'Australia East', 'Sydney', -33.87, 151.21, 'ap'],
  ['australiasoutheast', 'Australia Southeast', 'Melbourne', -37.81, 144.96, 'ap'],
  ['australiacentral', 'Australia Central', 'Canberra', -35.28, 149.13, 'ap'],
  ['newzealandnorth', 'New Zealand North', 'Auckland', -36.85, 174.76, 'ap'],
  ['indonesiacentral', 'Indonesia Central', 'Dżakarta', -6.21, 106.85, 'ap'],
  ['malaysiawest', 'Malaysia West', 'Kuala Lumpur', 3.14, 101.69, 'ap'],
  ['taiwannorth', 'Taiwan North', 'Tajpej', 25.03, 121.57, 'ap'],
];

const TIMEOUT_MS = 8000;

async function once(id) {
  const t0 = performance.now();
  try {
    const r = await fetch(`https://${id}.management.azure.com/metadata/endpoints?api-version=2022-09-01`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    await r.arrayBuffer().catch(() => {});
    return { ok: r.status === 200, code: r.status, ms: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false, code: 0, ms: Math.round(performance.now() - t0) };
  }
}

// fails: number of consecutive runs without a correct answer; one retry per run filters single dropped connections.
export async function probeRegions(prev = null, probe = once) {
  const before = new Map((prev?.list || []).map((r) => [r.id, r.fails || 0]));
  const list = await Promise.all(REGIONS.map(async ([id, name, city, lat, lon, geo]) => {
    let v = await probe(id);
    if (!v.ok) v = await probe(id);
    return { id, name, city, lat, lon, geo, ok: v.ok, code: v.code, ms: v.ms, fails: v.ok ? 0 : (before.get(id) || 0) + 1 };
  }));
  return { fetched: new Date().toISOString(), list };
}
