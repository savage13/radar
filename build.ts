import CRC32 from 'crc-32';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'better-sqlite3';

const beco = require('./beco');

const yaml = require('js-yaml');

import { PlacementMap, PlacementObj, PlacementLink, ResPlacementObj } from './app/PlacementMap';
import * as util from './app/util';

let parseArgs = require('minimist');

let argv = parseArgs(process.argv);

if (!argv.a) {
  console.log("Error: Must specify a path to directory with ActorLink and DropTable YAML files");
  console.log("       e.g. % ts-node build.ts -a ../botw/Actor")
  console.log("       YAML data files are available from https://github.com/leoetlino/botw");
  process.exit(1);
}
const botwData = argv.a;


const actorinfodata = JSON.parse(fs.readFileSync(path.join(util.APP_ROOT, 'content', 'ActorInfo.product.json'), 'utf8'));

const names: { [actor: string]: string } = JSON.parse(fs.readFileSync(path.join(util.APP_ROOT, 'content', 'names.json'), 'utf8'));
const getUiName = (name: string) => names[name] || name;
const locationMarkerTexts: { [actor: string]: string } = JSON.parse(fs.readFileSync(path.join(util.APP_ROOT, 'content', 'text', 'StaticMsg', 'LocationMarker.json'), 'utf8'));
const dungeonTexts: { [actor: string]: string } = JSON.parse(fs.readFileSync(path.join(util.APP_ROOT, 'content', 'text', 'StaticMsg', 'Dungeon.json'), 'utf8'));

const korok_data: [any] = JSON.parse(fs.readFileSync(path.join(util.APP_ROOT, 'korok_ids.json'), 'utf8'));
let korok_ids: any = {};
korok_data.forEach(k => { korok_ids[k.hash_id] = k; });

const polys = JSON.parse(fs.readFileSync(path.join(util.APP_ROOT, "castle.json"), 'utf-8'));

const mapTower = new beco.Beco(path.join(util.APP_ROOT, 'content', 'ecosystem', 'MapTower.beco'));
// Tower Names taken from Messages/Msg_USen.product.sarc/StaticMsg/LocationMarker.msyt Tower01 - Tower15
const towerNames = ["Hebra", "Tabantha", "Gerudo", "Wasteland", "Woodland",
  "Central", "Great Plateau", "Dueling Peaks", "Lake",
  "Eldin", "Akkala", "Lanayru", "Hateno", "Faron", "Ridgeland"];
const fieldArea = new beco.Beco(path.join(util.APP_ROOT, 'content', 'ecosystem', 'FieldMapArea.beco'));

const locations: { [key: string]: string } = JSON.parse(fs.readFileSync(path.join(util.APP_ROOT, 'content', 'locations.json'), 'utf8'));

// Create Special tags for YAML: !obj, !list, !io, !str64
const objType = new yaml.Type('!obj', {
  kind: 'mapping', instanceOf: Object,
  resolve: function(data: any) { return true; },
  construct: function(data: any) { return data; },
});
const listType = new yaml.Type('!list', {
  kind: 'mapping', instanceOf: Object,
  resolve: function(data: any) { return true; },
  construct: function(data: any) { return data; },
});
const ioType = new yaml.Type('!io', {
  kind: 'mapping', instanceOf: Object,
  resolve: function(data: any) { return true; },
  construct: function(data: any) { return data; },
});
const str64Type = new yaml.Type('!str64', {
  kind: 'scalar', instanceOf: String,
  resolve: function(data: any) { return true; },
  construct: function(data: any) { return data; },
});

// Add Special Tags to the Default schema (to facilitate reading)
let schema = yaml.DEFAULT_SCHEMA.extend([objType, listType, ioType, str64Type]);

function readYAML(filePath: string) {
  let doc: any = null;
  try {
    doc = yaml.load(fs.readFileSync(filePath, 'utf-8'), { schema: schema });
  } catch (e) {
    console.log(e);
    process.exit(1);
  }
  return doc;
}

function getDropTableNameFromActorLinkFile(doc: { [key: string]: any }): string | null {
  if ('DropTableUser' in doc.param_root.objects.LinkTarget) {
    let dropTableUser = doc.param_root.objects.LinkTarget.DropTableUser;
    return dropTableUser;
  }
  return null;
}
function getTagsFromActorLinkFile(doc: { [key: string]: any }): string[] | null {
  if ('Tags' in doc.param_root.objects) {
    let tags = doc.param_root.objects.Tags;
    return Object.values(tags);
  }
  return null;
}

function readDropTableFile(file: string) {
  let doc = readYAML(file)
  let tables: any = Object.keys(doc.param_root.objects)
    .filter(key => key != 'Header')
    .map(key => {
      let dropTable = doc.param_root.objects[key];
      let items: { [key: string]: any } = {};
      for (var i = 1; i <= dropTable.ColumnNum; i++) {
        let itemName = `ItemName${String(i).padStart(2, '0')}`;
        let itemProb = `ItemProbability${String(i).padStart(2, '0')}`;
        items[dropTable[itemName]] = dropTable[itemProb];
      }
      let data = {
        items: items,
        repeat_num: [dropTable.RepeatNumMin, dropTable.RepeatNumMax],
      };
      return { name: key, data: data };
    });
  return tables;
}

function readDropTablesByName(table: string) {
  return readDropTableFile(path.join(botwData, 'DropTable', `${table}.drop.yml`));
}

function readDropTables(lootTables: { [key: string]: string }) {
  let data: any[] = [];
  Object.keys(lootTables)
    .filter(name => lootTables[name] != "Dummy") // Ignore empty Dummy tables
    .forEach(name => {
      let tables = readDropTablesByName(lootTables[name]);
      tables.forEach((table: any) => table.actor_name = name); // Matches unit_config_name in table objs
      data.push(...tables);
    });
  return data;
}
function readYAMLData(): [any[], { [key: string]: string[] }, { [key: string]: any }, { [key: string]: any }] {
  let itemTags: { [key: string]: string[] } = {};
  let lootTables: { [key: string]: string } = {};
  let metaData: { [key: string]: any } = {};
  let actorProfile: { [key: string]: any } = {};

  let dirPath = path.join(botwData, 'ActorLink');
  let files = fs.readdirSync(dirPath);
  files.forEach(file => {
    let actorName = path.basename(file, '.yml'); // ==> UnitConfigName
    let filePath = path.join(botwData, 'ActorLink', file);
    let doc = readYAML(filePath);
    let tableName = getDropTableNameFromActorLinkFile(doc);
    if (tableName) {
      lootTables[actorName] = tableName;
    }
    actorProfile[actorName] = doc.param_root.objects.LinkTarget.ProfileUser
    let tags = getTagsFromActorLinkFile(doc);
    if (tags) {
      itemTags[actorName] = tags;
    }
    try {
      let meta = yaml.load(fs.readFileSync(path.join(botwData, 'ActorMeta', `${actorName}.yml`), 'utf-8'), { schema })
      if (meta) {
        metaData[actorName] = { boundingForTraverse: meta.boundingForTraverse, traverseDist: meta.traverseDist }
      }
    } catch (_) {

    }
  });
  let dropData: any[] = readDropTables(lootTables);
  return [dropData, itemTags, metaData, actorProfile];
}

let [dropData, itemTags, metaData, actorProfile] = readYAMLData();

const db = sqlite3('map.db.tmp');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE objs (
   objid INTEGER PRIMARY KEY,
   map_type TEXT NOT NULL,
   map_name TEXT NOT NULL,
   map_static BOOL,
   gen_group INTEGER,
   hash_id INTEGER,
   unit_config_name TEXT NOT NULL,
   ui_name TEXT NOT NULL,
   data JSON NOT NULL,
   one_hit_mode BOOL DEFAULT 0,
   last_boss_mode BOOL DEFAULT 0,
   hard_mode BOOL DEFAULT 0,
   disable_rankup_for_hard_mode BOOL DEFAULT 0,
   scale INTEGER DEFAULT 0,
   sharp_weapon_judge_type INTEGER DEFAULT 0,
   'drop' JSON,
   equip JSON,
   ui_drop TEXT,
   ui_equip TEXT,
   messageid TEXT,
   region TEXT NOT NULL,
   field_area INTEGER,
   spawns_with_lotm BOOL,
   korok_id TEXT,
   korok_type TEXT,
   location TEXT
  );
`);

db.exec(`
   CREATE TABLE drop_table (
     actor_name TEXT NOT NULL,
     name TEXT NOT NULL,
     data JSON
  );
`);

db.exec(`
   CREATE TABLE rails (
      hash_id INTEGER NOT NULL,
      data JSON
   );
`);

const insertObj = db.prepare(`INSERT INTO objs
  (map_type, map_name, map_static, gen_group, hash_id, unit_config_name, ui_name, data, one_hit_mode, last_boss_mode, hard_mode, disable_rankup_for_hard_mode, scale, sharp_weapon_judge_type, 'drop', equip, ui_drop, ui_equip, messageid, region, field_area, spawns_with_lotm, korok_id, korok_type, location)
  VALUES
  (@map_type, @map_name, @map_static, @gen_group, @hash_id, @unit_config_name, @ui_name, @data, @one_hit_mode, @last_boss_mode, @hard_mode, @disable_rankup_for_hard_mode, @scale, @sharp_weapon_judge_type, @drop, @equip, @ui_drop, @ui_equip, @messageid, @region, @field_area, @spawns_with_lotm, @korok_id, @korok_type, @location)`);

const insertRail = db.prepare(`INSERT INTO rails (hash_id, data) VALUES (@hash_id, @data)`);

function getActorData(name: string) {
  const h = CRC32.str(name) >>> 0;
  const hashes = actorinfodata['Hashes'];
  let a = 0, b = hashes.length - 1;
  while (a <= b) {
    const m = (a + b) >> 1;
    if (hashes[m] < h)
      a = m + 1;
    else if (hashes[m] > h)
      b = m - 1;
    else
      return actorinfodata['Actors'][m];
  }
  return null;
}

function isFlag4Actor(name: string) {
  if (name == 'Enemy_GanonBeast')
    return false;
  const info = getActorData(name);
  for (const x of ['Enemy', 'GelEnemy', 'SandWorm', 'Prey', 'Dragon', 'Guardian']) {
    if (info['profile'] == x)
      return true;
  }
  if (info['profile'].includes('NPC'))
    return true;
  return false;
}

function shouldSpawnObjForLastBossMode(obj: PlacementObj) {
  const name: string = obj.data.UnitConfigName;
  if (isFlag4Actor(name))
    return false;
  if (name == 'Enemy_Guardian_A')
    return false;
  if (name.includes('Entrance') || name.includes('WarpPoint') || name.includes('Terminal'))
    return false;
  return true;
}

function objGetUiName(obj: PlacementObj) {
  if (obj.data.UnitConfigName === 'LocationTag') {
    const id = obj.data['!Parameters'].MessageID;
    const locationName = locationMarkerTexts[id] || dungeonTexts[id];
    let s = `Location: ${locationName}`;
    const dungeonSub = dungeonTexts[id + '_sub'];
    if (dungeonSub)
      s += ' - ' + dungeonSub;
    return s;
  }
  return getUiName(obj.data.UnitConfigName);
}

function objGetDrops(params: any) {
  if (params.DropActor)
    return [1, params.DropActor];
  if (!params.DropActor && params.DropTable && params.DropTable != 'Normal')
    return [2, params.DropTable];
  return null;
}

function objGetUiDrops(params: any) {
  const info: string[] = [];
  if (params.DropActor)
    info.push(getUiName(params.DropActor));
  else if (params.DropTable && params.DropTable != 'Normal')
    info.push('Table:' + params.DropTable);
  return info.join('|');
}

function objGetEquipment(params: any) {
  const info: string[] = [];
  for (const prop of ['EquipItem1', 'EquipItem2', 'EquipItem3', 'EquipItem4', 'EquipItem5', 'RideHorseName']) {
    if ((prop in params) && params[prop] != 'Default')
      info.push(params[prop]);
  }
  if (params['ArrowName'] && params['ArrowName'] != 'NormalArrow') {
    info.push(params['ArrowName']);
  }
  return info;
}

function objGetUiEquipment(params: any) {
  return objGetEquipment(params).map(getUiName).join(', ');
}

function hasLiftRock(group: any[]) {
  return group.map(objGetUiName)
    .some(name => name.includes("LiftRock") && !name.includes("Korok"));
}

function arrayEquals(a: string[], b: string[]): boolean {
  if (a.length != b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

function korokGetType(group: any[], obj: any): string {
  let len = group.length;
  let names: string[] = group.map(objGetUiName);
  names.sort();

  if (hasLiftRock(group)) {
    switch (len) {
      case 7: return "Rock Lift"; // 174
      case 9:
        return "Rock Lift (Rock Pile)"; // 40
      case 11:
        if (names.includes("Treasure Chest")) {
          return "Rock Lift (Rock Pile)"; // 1
        }
        if (names.includes("Obj_BoardIron_C_01")) {
          return "Rock Lift (Door)"; // 8
        }
        if (names.includes("FldObj_PushRock_A_M_01")) {
          return "Rock Lift (Boulder)"; // 6
        }
        return "Rock Lift (Slab)"; // 21
      case 23:
        return "Rock Lift (Leaves)"; // 19
      case 14:
      case 22:
      case 30:
        return "Rock Pattern"; // 72
      default:
        break;
    }
  }
  if (names.includes("FldObj_KorokPinwheel_A_01")) { // 56
    switch (len) {
      case 5: return "Stationary Lights";
      case 15: return "Pinwheel Balloons";
      case 23: return "Pinwheel Balloons";
      case 27: return "Pinwheel Acorns";
      case 31: return "Pinwheel Balloons";
      case 46: return "Pinwheel Acorns";
      case 64: return "Pinwheel Acorns";
      default:
        break;
    }
  }

  let identifiers: { [key: string]: string } = {
    "Obj_Plant_KorokColor_A_01": "Flower Order",                       // 11
    "Obj_Plant_Korok_A_01": "Flower Trail",                            // 46
    "FldObj_RuinStonePavement_A_06": "Offering Plate",                 // 27 + 1 (egg)
    "Obj_KorokPlate_A_01": "Offering Plate",                           //
    "FldObj_KorokGoal_A_01": "Goal Ring (Race)",                       // 51
    "Obj_TreeCactusMini_A_01": "Matching Trees",                       // 5
    "Obj_TreeDorian_A_01": "Matching Trees",                           // 3
    "Obj_Plant_IvyBurn_A_01": "Burn the Leaves (Goatee)",              // 1
    "FidObj_TorchStandOff_A_01": "Light Torch",                        // 1
    "Tree Branch": "Take the Stick",                                   // 1
    "Luminous Stone": "Remove Luminous Stone",                         // 1
    "YabusameBow": "Shoot the Targets",                                // 1
    "TwnObj_Village_FishingHouse_S_A_02": "Take Apple from Palm Tree", // 1
    "Obj_TreeApple_A_M_01": "Matching Trees",                          // 12
    "SignalFlowchart": "Jump the Fences",                              // 2
    "Obj_BoxIron_A_M_01": "Rock Pattern",                              // 1 "Arrange Metal cubes under water"
    "BrokenSnowBall": "Roll a Boulder",                                // 2 "Push Snowball in Hole"
    "IceWall": "Melt Ice Block",                                       // 18
    "PointWindSetTag": "Roll a Boulder",                               // 1 "Push Boulder into Hole off Pillar"
  };

  if (len == 1) {
    if ('LinksToRail' in group[0].data) {
      return "Moving Lights"; // 39
    }
    return "Stationary Lights"; // 46
  }
  for (const name of names) {
    if (name in identifiers) {
      return identifiers[name];
    }
  }
  if (names.includes("Obj_KorokPot_A_01")) {
    if (names.length == 6) {
      return "Acorn in a Hole"; // 29
    }
    return "Hanging Acorn"; // 14
  }
  if (names.includes("FldObj_ChainEyeBolt_A_01")) { // Must follow Acorn
    return "Ball and Chain"; // 14
  }
  if (names.includes("FldObj_KorokTarget_A_01")) { // Must follow Acorn
    return "Stationary Balloon"; // 26
  }
  if (len == 21 && names.includes("FldObj_KorokStoneLift_A_01") && names.includes("FldObj_KorokStone_A_01")) {
    return "Cube Puzzle"; // 66
  }
  if (arrayEquals(names, ['ActorObserverTag', 'Area', 'Area', 'FldObj_PushRock_Korok', 'FldObj_PushRock_Korok',
    'FldObj_PushRock_Korok', 'Korok', 'KorokAnswerResponce', 'LinkTagAnd', 'LinkTagAnd',
    'LinkTagNone', 'LinkTagOr', 'LinkTagOr', 'SwitchTimeLag'])) {
    return "Roll a Boulder"; // 1 Must preceed Push Boulder into Hole
  }
  if (names.includes("FldObj_PushRock_A_M_01")) {
    return "Roll a Boulder";
  }
  if (names.includes("FldObj_PushRock_Korok")) {
    return "Roll a Boulder";
  }
  if (names.includes("Obj_KorokIronRock_A_01")) {
    return "Ball and Chain";
  }
  if (names.includes("FldObj_PushRockIron_A_M_01")) {
    return "Roll a Boulder"; // Must follow Boulder Between Trees
  }
  // Specific Korok Types without Specific Tags

  if (arrayEquals(names, ['Area', 'Korok', 'LinkTagOr', 'LinkTagOr'])) {
    return "Stationary Lights"; // 41
  }
  if (arrayEquals(names, ['Area', 'Korok', 'LinkTagAnd', 'LinkTagOr'])) {
    return "Dive"; // 35
  }
  if (arrayEquals(names, ['ActorObserverTag', 'ActorObserverTag', 'ActorObserverTag', 'Area', 'Korok',
    'KorokAnswerResponce', 'LinkTagAnd', 'LinkTagAnd', 'LinkTagOr', 'LinkTagOr', 'SwitchTimeLag'])) {
    return "Circle of Rocks"; // 20
  }
  if (arrayEquals(names, ['ActorObserverByGroupTag', 'Area', 'Area', 'Korok', 'LinkTagAnd', 'LinkTagAnd',
    'LinkTagNAnd', 'LinkTagOr'])) {
    return "Shoot the Crest"; // 4
  }
  if (arrayEquals(names, ['ActorObserverTag', 'ActorObserverTag', 'Area', 'Area', 'Korok',
    'KorokAnswerResponce', 'KorokAnswerResponce', 'LinkTagAnd', 'LinkTagAnd', 'LinkTagAnd',
    'LinkTagOr', 'SwitchTimeLag'])) {
    return "Ball and Chain"; // 1
  }
  if (arrayEquals(names, ['ActorObserverTag', 'ActorObserverTag', 'ActorObserverTag', 'Area',
    'Area', 'Area', 'Korok', 'LinkTagAnd', 'LinkTagAnd', 'LinkTagOr', 'SwitchTimeLag'])) {
    return "Offering Plate"; //Put Egg in Water"; 1
  }
  if (arrayEquals(names, ['ActorObserverTag', 'Area', 'Area', 'Korok', 'KorokAnswerResponce',
    'LinkTagAnd', 'LinkTagAnd', 'LinkTagAnd', 'LinkTagNone', 'LinkTagOr', 'SwitchTimeLag'])) {
    return "Roll a Boulder"; //"Push Boulder into Hole"; // 6
  }
  if (arrayEquals(names, ['Korok', 'LinkTagAnd', 'LinkTagAnd', 'LinkTagAnd', 'LinkTagNAnd'])) {
    return "Stationary Lights"; //"Shrine of Resurrection"; // 1
  }

  console.error(names);
  console.error(len);
  console.error(`Unhandled Korok Type: ${objGetUiName(obj)} ${obj.data.HashId}`);
  process.exit(1);
}

// Check is a point (x,y,z) is contained within a polygon's bounding box
//   Bounding box is defined in properties (xmin, xmax, zmin, zmax)
function isPointInsideBoundingBox(poly: any, pt: any): boolean {
  let prop = poly.properties;
  return ((prop.xmin && pt[0] >= prop.xmin) ||
    (prop.zmin && pt[2] >= prop.zmin) ||
    (prop.xmax && pt[0] <= prop.xmax) ||
    (prop.zmax && pt[2] <= prop.zmax));
}

// Check is a point (x,y,z) is contained within a polygon
//   The bounding box is first checked then the polygon is checked
function isPointInsidePolygon(poly: any, pt: any): boolean {
  return isPointInsideBoundingBox(poly, pt) && isPointInsidePolygonRCA(pt, poly.geometry.coordinates[0]);
}

// Check if a point is within a polygon (pts)
//  https://en.wikipedia.org/wiki/Point_in_polygon#Ray_casting_algorithm
function isPointInsidePolygonRCA(point: any, pts: any) {
  let n = pts.length;
  let xp = point[0];
  let yp = point[2];
  let xv: any = pts.map((p: any) => p[0]);
  let yv: any = pts.map((p: any) => p[1]);

  if (Math.abs(xv[0] - xv[n - 1]) < 1e-7 && Math.abs(yv[0] - yv[n - 1]) < 1e-7) {
    n -= 1;
  }
  let x2 = xv[n - 1]
  let y2 = yv[n - 1]
  let nleft = 0

  let x1 = x2;
  let y1 = y2;

  // Loop over line segments (assuming the polygon is closed)
  for (let i = 0; i < n; i++) {
    x1 = x2
    y1 = y2
    x2 = xv[i]
    y2 = yv[i]
    if (y1 >= yp && y2 >= yp) {
      continue;
    }
    if (y1 < yp && y2 < yp) {
      continue;
    }
    if (y1 == y2) {
      if (x1 >= xp && x2 >= xp) {
        continue;
      }
      if (x1 < xp && x2 < xp) {
        continue;
      }
      nleft += 1;
    } else {
      let xi = x1 + (yp - y1) * (x2 - x1) / (y2 - y1);
      if (xi == xp) {
        nleft = 1;
        break;
      }
      if (xi > xp) {
        nleft += 1;
      }
    }
  }
  let xin = nleft % 2;
  return xin == 1;
}

// Test all polygons (polys) if a point lies in any
//    polygons are assumed to be in GeoJSON format and have:
//      - a bounding box (xmin,ymin,zmin,xmax,ymax,zmax)
//      - a priority where overlapping polygons with higher priority are chosen
//    Returns the found polygon or null in the case of no match
function findPolygon(p: any, polys: any) {
  let found = null;
  for (let j = 0; j < polys.features.length; j++) {
    const poly = polys.features[j];
    if ((poly.properties.ymin && p[1] < poly.properties.ymin) ||
      (poly.properties.ymax && p[1] > poly.properties.ymax)) {
      continue;
    }
    if (found && poly.properties.priority < found.properties.priority) {
      continue;
    }
    if (isPointInsidePolygon(poly, p)) {
      found = polys.features[j];
    }
  }
  return found;
}

function processMap(pmap: PlacementMap, isStatic: boolean): void {
  process.stdout.write(`processing ${pmap.type}/${pmap.name} (static: ${isStatic})`);
  const hashIdToObjIdMap: Map<number, any> = new Map();

  const genGroups: Map<number, PlacementObj[]> = new Map();
  const genGroupSkipped: Map<number, boolean> = new Map();
  for (const obj of pmap.getObjs()) {
    if (!genGroups.has(obj.genGroupId))
      genGroups.set(obj.genGroupId, []);
    genGroups.get(obj.genGroupId)!.push(obj);
  }
  for (const [id, genGroup] of genGroups.entries())
    genGroupSkipped.set(id, genGroup.some(o => !shouldSpawnObjForLastBossMode(o)));

  for (const obj of pmap.getObjs()) {
    let params = obj.data['!Parameters'];

    let scale = params ? params.LevelSensorMode : 0;
    if (!obj.data.UnitConfigName.startsWith('Weapon_') && !obj.data.UnitConfigName.startsWith('Enemy_'))
      scale = null;

    let area = -1;
    if (pmap.type == 'MainField') {
      area = fieldArea.getCurrentAreaNum(obj.data.Translate[0], obj.data.Translate[2]);
    }
    let lotm = false;
    let objTags = itemTags[obj.data.UnitConfigName];
    if (area == 64 && objTags) {
      lotm = objTags.includes('UnderGodForest');
    }
    let korok = null;
    if (obj.data.HashId in korok_ids) {
      korok = korok_ids[obj.data.HashId].id;
    }
    let korok_type = null;
    if (objGetUiName(obj) == "Korok") {
      let group = genGroups.get(obj.genGroupId)!;
      korok_type = korokGetType(group, obj);
    }
    let location = null;
    if (obj.data.HashId in locations) {
      location = locations[obj.data.HashId];
    }

    let poly = findPolygon(obj.data.Translate, polys);
    if (poly) {
      location = poly.properties.name;
    }

    if (obj.data.UnitConfigName in metaData) {
      if (!(obj.data['!Parameters'])) {
        // @ts-ignore
        obj.data['!Parameters'] = {}
        params = obj.data['!Parameters']
      }
      params.ActorMeta = metaData[obj.data.UnitConfigName]
    }
    if (obj.data.UnitConfigName in actorProfile) {
      if (!(obj.data['!Parameters'])) {
        // @ts-ignore
        obj.data['!Parameters'] = {}
        params = obj.data['!Parameters']
      }
      params.ProfileUser = actorProfile[obj.data.UnitConfigName]
    }

    const result = insertObj.run({
      map_type: pmap.type,
      map_name: pmap.name,
      map_static: isStatic ? 1 : 0,
      gen_group: obj.genGroupId,
      hash_id: obj.data.HashId,
      unit_config_name: obj.data.UnitConfigName,
      ui_name: objGetUiName(obj),
      data: JSON.stringify(obj.data),
      one_hit_mode: (params && params.IsIchigekiActor) ? 1 : 0,
      last_boss_mode: genGroupSkipped.get(obj.genGroupId) ? 0 : 1,
      hard_mode: (params && params.IsHardModeActor) ? 1 : 0,
      disable_rankup_for_hard_mode: (params && params.DisableRankUpForHardMode) ? 1 : 0,
      scale,
      sharp_weapon_judge_type: params ? params.SharpWeaponJudgeType : 0,
      drop: params ? JSON.stringify(objGetDrops(params)) : null,
      equip: params ? JSON.stringify(objGetEquipment(params)) : null,
      ui_drop: params ? objGetUiDrops(params) : null,
      ui_equip: params ? objGetUiEquipment(params) : null,
      messageid: params ? (params['MessageID'] || null) : null,
      region: pmap.type == 'MainField' ? towerNames[mapTower.getCurrentAreaNum(obj.data.Translate[0], obj.data.Translate[2])] : "",
      field_area: area >= 0 ? area : null,
      spawns_with_lotm: lotm ? 1 : 0,
      korok_id: korok ? korok : null,
      korok_type: korok_type,
      location: location,
    });
    hashIdToObjIdMap.set(obj.data.HashId, result.lastInsertRowid);
  }

  for (const rail of pmap.getRails()) {
    insertRail.run({ hash_id: rail.data.HashId, data: JSON.stringify(rail.data) });
  }
  process.stdout.write('.\n');
}

function processMaps() {
  const MAP_PATH = path.join(util.APP_ROOT, 'content/map');
  for (const type of fs.readdirSync(MAP_PATH)) {
    const typeP = path.join(MAP_PATH, type);
    for (const name of fs.readdirSync(typeP)) {
      const nameP = path.join(typeP, name);
      if (!util.isDirectory(nameP))
        continue;

      let fileName = `${name}_Static.json`;
      let data: object = JSON.parse(fs.readFileSync(path.join(nameP, fileName), 'utf8'));
      const staticMap = new PlacementMap(type, name, data);

      fileName = `${name}_Dynamic.json`;
      data = JSON.parse(fs.readFileSync(path.join(nameP, fileName), 'utf8'));
      const dynamicMap = new PlacementMap(type, name, data);

      processMap(staticMap, true);
      processMap(dynamicMap, false);
    }
  }
}
db.transaction(() => processMaps())();

function createDropTable() {
  let stmt = db.prepare(`INSERT INTO drop_table (actor_name, name, data) VALUES (@actor_name, @name, @data)`);
  dropData.forEach((row: any) => {
    let result = stmt.run({ actor_name: row.actor_name, name: row.name, data: JSON.stringify(row.data) });
  });
}

console.log('creating drop data table...');
db.transaction(() => createDropTable())();

function createIndexes() {
  db.exec(`
    CREATE INDEX objs_map ON objs (map_type, map_name);
    CREATE INDEX objs_map_type ON objs (map_type);
    CREATE INDEX objs_hash_id ON objs (hash_id);
    CREATE INDEX objs_gen_group ON objs (gen_group);
    CREATE INDEX objs_unit_config_name ON objs (unit_config_name);
  `);
}
console.log('creating indexes...');
createIndexes();


function checkKorokTypes() {
  const counts = {                  // Notes based on https://lepelog.github.io/korokmap/
    "Moving Lights": 39,            //
    "Stationary Lights": 51,        //
    "Rock Lift (Door)": 8,          //
    "Rock Lift (Boulder)": 6,       //
    "Rock Lift (Rock Pile)": 41,    // Z54 is under Rock Pile
    "Rock Lift (Slab)": 12,         //
    "Rock Lift": 174,               //
    "Rock Pattern": 73,             // C51, L34, and N13 are not Rock Patterns
    "Cube Puzzle": 66,              //
    "Goal Ring (Race)": 51,         //
    "Flower Trail": 46,             //
    "Pinwheel Balloons": 44,        //
    "Dive": 35,                     //
    "Acorn in a Hole": 29,          //
    "Roll a Boulder": 31,           // C51, L34, and N13 are not Rock Patterns but Push Boulder
    "Offering Plate": 28,           // 27 + 1 (egg)
    "Stationary Balloon": 26,       //
    "Circle of Rocks": 20,          //
    "Matching Trees": 20,           //
    "Rock Lift (Leaves)": 19,       //
    "Melt Ice Block": 18,           //
    "Ball and Chain": 16,           //
    "Hanging Acorn": 14,            //
    "Flower Order": 11,             //
    "Pinwheel Acorns": 10,          //
    "Shoot the Crest": 4,           //
    "Jump the Fences": 2,           //
    "Light Torch": 1,               //
    "Burn the Leaves (Goatee)": 1,  //
    "Take the Stick": 1,            //
    "Shoot the Targets": 1,         //
    "Take Apple from Palm Tree": 1, //
    "Remove Luminous Stone": 1,     //
  };
  // Check the number of koroks in each category
  let expectedNum = 0;
  const stmt = db.prepare("select count(korok_type) as num from objs where korok_type = @kt");
  for (const [key, num] of Object.entries(counts)) {
    const res = stmt.all({ kt: key });

    if (res.length != 1) {
      console.error(`Expected a single value, got ${res}, ${res.length}`);
      process.exit(1);
    }
    let out = res[0].num;
    if (out != num) {
      console.error(`Number of korok types mismatch: ${key}: expected ${num} returned ${out}`);
      process.exit(1);
    }
    expectedNum += out;
  }
  // Check we have 900 koroks
  if (expectedNum != 900) {
    console.error(`Error: Expected 900 koroks, got ${expectedNum}`);
    process.exit(1);
  }
  // Checking for unknown korok types
  const res = db.prepare("select distinct(korok_type) as name from objs where korok_type is not NULL").all();
  const names = res.map(row => row.name);
  if (names.some(name => !(name in counts))) {
    const ktypes = names.filter(name => !(name in counts));
    console.error(`Error: Unknown korok types: ${ktypes}`);
    process.exit(1);
  }
}
console.log("checking korok types ...");
checkKorokTypes();

function createFts() {
  db.exec(`
    CREATE VIRTUAL TABLE objs_fts USING fts5(content="", tokenize="unicode61", map, actor, name, data, 'drop', equip, onehit, lastboss, hard, no_rankup, scale, bonus, static, region, fieldarea, lotm, korok, korok_type, location);

    INSERT INTO objs_fts(rowid, map, actor, name, data, 'drop', equip, onehit, lastboss, hard, no_rankup, scale, bonus, static, region, fieldarea, lotm, korok, korok_type, location)
    SELECT objid, map_type || '/' || map_name, unit_config_name, ui_name, data, ui_drop, ui_equip, one_hit_mode, last_boss_mode, hard_mode, disable_rankup_for_hard_mode, scale, sharp_weapon_judge_type, map_static, region, field_area, spawns_with_lotm, korok_id, korok_type, location FROM objs;
  `);
}
console.log('creating FTS tables...');
createFts();

db.close();
fs.renameSync('map.db.tmp', 'map.db');
