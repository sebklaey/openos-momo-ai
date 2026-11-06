"use strict";
const gw = document.getElementById("gw");
const customWrap = document.getElementById("customWrap");
const customGw = document.getElementById("customGw");

chrome.storage.local.get({ gateway: "dweb", customGateway: "" }).then(d => {
  gw.value = d.gateway;
  customGw.value = d.customGateway || "";
  customWrap.style.display = d.gateway === "custom" ? "block" : "none";
});

gw.addEventListener("change", () => {
  customWrap.style.display = gw.value === "custom" ? "block" : "none";
  chrome.storage.local.set({ gateway: gw.value });
});
customGw.addEventListener("change", () => {
  chrome.storage.local.set({ customGateway: customGw.value.trim() });
});
