"use strict";

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function shell(company, name, email, extensionNumber, loginPhones) {
  const phones = (Array.isArray(loginPhones) ? loginPhones : [loginPhones])
    .map(normalizePhone)
    .filter(Boolean);
  return {
    prefix: String(email || "").trim().toLowerCase().split("@")[0] || null,
    company: String(company || "").trim().toUpperCase() || null,
    name: name || null,
    email: String(email || "").trim().toLowerCase() || null,
    extensionNumber: extensionNumber != null ? String(extensionNumber).trim() : null,
    loginPhones: phones,
    primaryPhone: phones[0] || null,
    source: "agent-phone-directory-2026-04-13",
  };
}

const EX_SHELL_DIRECTORY = Object.freeze([
  shell("TAG", "Alexander Banks", "abanks@taxadvocategroup.com", "800", ["8186389190"]),
  shell("TAG", "Alazey Cordero", "acordero@taxadvocategroup.com", "1035", ["2137841686", "2133344761"]),
  shell("TAG", "Andrew Wells", "awells@taxadvocategroup.com", "365", ["8183961862"]),
  shell("WYNN", "Andrew Wells", "awells@wynntaxsolutions.com", "3651", ["9498890317"]),
  shell("AMITY", "Andrew Wells", "awells@amitytaxgroup.com", "3652", ["9496030852"]),
  shell("TAG", "Anthony Calloway", "acalloway@taxadvocategroup.com", "209", ["8182064601", "2133344946"]),
  shell("TAG", "Bruce Allen", "ballen@taxadvocategroup.com", "966", ["7473077280", "3214008642"]),
  shell("WYNN", "Bruce Allen", "ballen@wynntaxsolutions.com", "9661", ["9498893027"]),
  shell("AMITY", "Bruce Allen", "ballen@amitytaxgroup.com", "9662", ["9495231261"]),
  shell("TAG", "Dani Pearson", "dpearson@taxadvocategroup.com", "525", ["8182351306"]),
  shell("WYNN", "Dani Pearson", "dpearson@wynntaxsolutions.com", "5251", ["9492025486"]),
  shell("AMITY", "Dani Pearson", "dpearson@amitytaxgroup.com", "5252", ["9493283673"]),
  shell("TAG", "Eli Hayes", "ehayes@taxadvocategroup.com", "810", ["8183344107"]),
  shell("WYNN", "Eli Hayes", "ehayes@wynntaxsolutions.com", "8101", ["9498890136"]),
  shell("AMITY", "Eli Hayes", "ehayes@amitytaxgroup.com", "8102", ["9492732787"]),
  shell("TAG", "Jackie Rose", "jrose@taxadvocategroup.com", "325", ["3104214256"]),
  shell("TAG", "Jacqueline Santos", "jsantos@taxadvocategroup.com", "111", ["3104245342"]),
  shell("TAG", "Jake Wallace", "jwallace@taxadvocategroup.com", "140", ["8187930820"]),
  shell("WYNN", "Jake Wallace", "jwallace@wynntaxsolutions.com", "1401", ["9496206272"]),
  shell("AMITY", "Jake Wallace", "jwallace@amitytaxgroup.com", "1402", ["9493566458"]),
  shell("TAG", "Jonathan Haro", "jharo@taxadvocategroup.com", "731", ["8182394141"]),
  shell("WYNN", "Jonathan Haro", "jharo@wynntaxsolutions.com", "7311", ["9495708747"]),
  shell("AMITY", "Jonathan Haro", "jharo@amitytaxgroup.com", "7312", ["9495212800"]),
  shell("TAG", "Jonathan Pineda", "jpineda@taxadvocategroup.com", "13", ["8182877352", "8182064689"]),
  shell("TAG", "Leo Collins", "lcollins@taxadvocategroup.com", "94", ["8183968986"]),
  shell("AMITY", "Leo Collins", "lcollins@amitytaxgroup.com", "9494", ["9496032994"]),
  shell("TAG", "Matthew Anderson", "manderson@taxadvocategroup.com", "320", ["2137577884"]),
  shell("WYNN", "Matthew Anderson", "manderson@wynntaxsolutions.com", "43255", ["9494043702"]),
  shell("AMITY", "Matthew Anderson", "manderson@amitytaxgroup.com", "3202", ["9499945875"]),
  shell("TAG", "Michael Gray", "mgray@taxadvocategroup.com", "101", ["8183345587", "8182728593"]),
  shell("TAG", "Monica Cazares", "mcazares@taxadvocategroup.com", "343", ["2137552087"]),
  shell("WYNN", "Monica Cazares", "mcazares@wynntaxsolutions.com", "3431", ["9494045437"]),
  shell("AMITY", "Monica Cazares", "mcazares@amitytaxgroup.com", "3432", ["9492472387"]),
  shell("TAG", "Neyla Ramirez", "nramirez@taxadvocategroup.com", "281", ["8185720260"]),
  shell("WYNN", "Neyla Ramirez", "nramirez@wynntaxsolutions.com", "2811", ["9496088445"]),
  shell("AMITY", "Neyla Ramirez", "nramirez@amitytaxgroup.com", "2812", ["9493163542"]),
  shell("TAG", "Phil Olson", "polson@taxadvocategroup.com", "319", ["8182063751"]),
]);

function cloneShell(entry) {
  return {
    ...entry,
    loginPhones: [...(entry.loginPhones || [])],
  };
}

function findExShellsForEmail(email) {
  const prefix = String(email || "").trim().toLowerCase().split("@")[0] || "";
  if (!prefix) return [];
  return EX_SHELL_DIRECTORY.filter((entry) => entry.prefix === prefix).map(cloneShell);
}

module.exports = {
  EX_SHELL_DIRECTORY,
  findExShellsForEmail,
};
