// Сравнение data.js с версией в репозитории без метки времени сбора.
//
//   node _tools/data_changed.js --head data.js     сравнить с HEAD
//   node _tools/data_changed.js <старый> <новый>   сравнить два файла
//
// Код возврата: 0 — расписание одинаковое, 1 — различается, 2 — ошибка чтения.
// Метка "updated" меняется при каждом сборе, поэтому в сравнении не участвует:
// иначе получался бы пустой коммит каждый день.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function normalize(text) {
    return text.replace(/"updated"\s*:\s*"[^"]*"/, '"updated":""').trim();
}

function readFile(file) {
    try {
        return fs.readFileSync(file, "utf8");
    } catch (e) {
        console.error("не читается " + file + ": " + e.message);
        process.exit(2);
    }
}

function readHead(file) {
    const rel = path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/");
    try {
        return execFileSync("git", ["show", "HEAD:" + rel], {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024
        });
    } catch (e) {
        const msg = String((e.stderr || e.message || "")).trim();
        console.error("не удалось прочитать HEAD:" + rel + " из git" + (msg ? ": " + msg : ""));
        process.exit(2);
    }
}

const args = process.argv.slice(2);

if (args[0] === "--head") {
    if (!args[1]) {
        console.error("использование: node _tools/data_changed.js --head data.js");
        process.exit(2);
    }
    process.exit(normalize(readHead(args[1])) === normalize(readFile(args[1])) ? 0 : 1);
}

if (args.length !== 2) {
    console.error("использование: node _tools/data_changed.js --head data.js");
    console.error("       или: node _tools/data_changed.js <старый> <новый>");
    process.exit(2);
}

process.exit(normalize(readFile(args[0])) === normalize(readFile(args[1])) ? 0 : 1);
