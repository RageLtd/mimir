import { attempt } from "@mimir/plugin-core/result";

/**
 * One filesystem resource assembled from ordered layers (shallowest first,
 * deepest wins). Each layer is a file plus the parser for its format; a
 * parser never throws — it returns what it could salvage and the problems
 * it found, so one bad file degrades that layer instead of the resource.
 */
export type Parsed<T> = { value: T; errors: string[] };
export type Layer<T> = { path: string; parse: (text: string) => Parsed<T> };
export type ResourceSpec<T> = {
  name: string;
  layers: Layer<T>[];
  empty: T;
  merge: (base: T, over: T) => T;
};

export type LayerStatus = "missing" | "unreadable" | "loaded";
export type LayerReport = {
  path: string;
  status: LayerStatus;
  errors: string[];
};
export type Loaded<T> = { value: T; reports: LayerReport[] };

export const loadResource = async <T>(spec: ResourceSpec<T>) => {
  let value = spec.empty;
  const reports: LayerReport[] = [];
  for (const layer of spec.layers) {
    const file = Bun.file(layer.path);
    if (!(await file.exists())) {
      reports.push({ path: layer.path, status: "missing", errors: [] });
      continue;
    }
    const [readError, text] = await attempt(() => file.text());
    if (readError !== null) {
      reports.push({
        path: layer.path,
        status: "unreadable",
        errors: [readError.message],
      });
      continue;
    }
    const parsed = layer.parse(text);
    value = spec.merge(value, parsed.value);
    reports.push({ path: layer.path, status: "loaded", errors: parsed.errors });
  }
  return { value, reports } as Loaded<T>;
};

export const loadedCount = (reports: LayerReport[]) =>
  reports.filter((report) => report.status === "loaded").length;
