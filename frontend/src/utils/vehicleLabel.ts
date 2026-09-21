/**
 * Shared vehicle display + search helpers, so every module labels and
 * filters vehicles the same way.
 *
 * Display format:   VID-385 - TT10 3A-3893
 *                   ^code     ^plate number
 *
 * `code` comes from the Wialon fleet report and is overlaid onto the unit
 * list by /api/vehicle-logs/vehicle-options. It can legitimately be empty
 * (fleet report unavailable, or a unit missing from it), in which case the
 * label falls back to the plate number alone rather than showing a stray
 * separator.
 */

export interface VehicleOption {
  id: number;
  /** Wialon unit name -- in practice the plate number. */
  name: string;
  /** Fleet code, e.g. "VID-385". May be absent. */
  code?: string;
}

/** "VID-385 - TT10 3A-3893", or just the plate when there is no code. */
export function vehicleLabel(v: Pick<VehicleOption, "name" | "code">): string {
  const code = (v.code || "").trim();
  const plate = (v.name || "").trim();
  if (code && plate) return `${code} - ${plate}`;
  return plate || code || "-";
}

/**
 * Options ready for an antd <Select showSearch optionFilterProp="label">.
 * Because the label contains both code and plate, typing any part of
 * either narrows the list -- "385", "VID", "TT10" and "3893" all match
 * the example above.
 */
export function vehicleSelectOptions(vehicles: VehicleOption[]) {
  return vehicles.map((v) => ({ value: v.id, label: vehicleLabel(v) }));
}

/** Look up a vehicle's label by id, for rendering table cells. */
export function vehicleLabelById(
  vehicles: VehicleOption[],
  id: number | null | undefined
): string {
  if (id == null) return "-";
  const match = vehicles.find((v) => v.id === id);
  return match ? vehicleLabel(match) : String(id);
}

/**
 * Case-insensitive match of a free-text query against a row's code and
 * plate. Used by the report screens, which filter rows already loaded in
 * the browser rather than re-querying the API.
 */
export function matchesVehicleSearch(
  row: { code?: string | null; plate_number?: string | null },
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    String(row.code ?? "").toLowerCase().includes(q) ||
    String(row.plate_number ?? "").toLowerCase().includes(q)
  );
}
