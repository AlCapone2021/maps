import { either } from "fp-ts";
import { enableMapSet, produce } from "immer";
import * as t from "io-ts";
import * as mapshaper from "mapshaper";
import { NextApiRequest, NextApiResponse } from "next";
import { Options, Shape } from "src/shared";
import Cors from "cors";

enableMapSet();

async function get(url: string) {
  return fetch(url)
    .then((res) => res.arrayBuffer())
    .then((ab) => Buffer.from(ab));
}

function initMiddleware(middleware: $FixMe) {
  return (req: NextApiRequest, res: NextApiResponse) =>
    new Promise((resolve, reject) => {
      middleware(req, res, (result: unknown) => {
        if (result instanceof Error) {
          return reject(result);
        }
        return resolve(result);
      });
    });
}

const cors = initMiddleware(
  Cors({
    methods: ["GET", "POST", "OPTIONS"],
  })
);

const Query = t.type({
  year: t.union([t.undefined, t.string]),
  shapes: t.union([t.undefined, t.string]),
  download: t.union([t.undefined, t.string]),
});

const defaultOptions: Options = {
  year: "2020",
  shapes: new Set<Shape>(["switzerland", "cantons", "lakes"]),
};

const VERSION = "4.0.0-canary.3";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    await cors(req, res);

    const query = either.getOrElseW<unknown, undefined>(() => undefined)(
      Query.decode(req.query)
    );

    if (!query) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("Failed to decode query");
      return;
    }

    const options = produce(defaultOptions, (draft) => {
      draft.shapes = new Set([
        ...(draft.shapes?.values() ?? []),
        ...(query.shapes?.split(",") ?? ([] as $FixMe)),
      ]);
    });
    const { year, shapes } = options;
    // console.log(year, shapes);

    const input = await (async () => {
      const shapeToKey: Record<Shape, string> = {
        switzerland: "l",
        cantons: "k",
        districts: "k", // FIXME: districts not available as shapefiles in the swiss-maps package yet.
        municipalities: "g",
        lakes: "s",
      };

      const props = [...(shapes?.values() ?? [])].flatMap((shape) => {
        const key = shapeToKey[shape];

        return ["shp", "dbf", "prj"].map(
          async (ext) =>
            [
              `${shape}.${ext}`,
              await get( // fs.readFile(path.resolve("swiss-maps/shapefile/…"))
                `https://unpkg.com/swiss-maps@${VERSION}/shapefile/${year}/${key}.${ext}`
              ),
            ] as const
        );
      });

      return Object.fromEntries(await Promise.all(props));
    })();

    await new Promise((resolve, reject) => {
      const shp = [...options.shapes!.values()];

      mapshaper.applyCommands(
        [
          `-i ${shp.map(
            (x) => `${x}.shp`
          )} combine-files string-fields=* encoding=utf8`,
          "-clean",
          // `-rename-layers ${shp.join(",")}`,
          "-proj wgs84",
          "-o format=topojson drop-table id-field=GMDNR,KTNR,GMDE,KT",
        ].join(" "),
        input,
        (err: unknown, output: $FixMe) => {
          if (err) {
            reject(err);
          } else {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");

            if (query.download !== undefined) {
              res.setHeader(
                "Content-Disposition",
                `attachment; filename="topo.json"`
              );
            }

            res.end(output["output.json"]);
            resolve();
          }
        }
      );
    });
  } catch (e) {
    console.log(e);
  }
}
