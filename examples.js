// Examples of good papers (index.html): cards placed by chance of acceptance relative to the
// scoring model's base rate (p / prior), so one threshold at 1x works for both models.
    // p: the result's p_accept (schema 3, prior-corrected); acc: the real decision.
    const PRIOR = { iclr: 0.314, arxiv: 0.232 };
    const BASE_NOTE = { iclr: "ICLR accepts ~31%", arxiv: "top venues accept ~25%" };
    const PAPERS = [
      { t: "Segment Anything", v: "ICCV 2023", m: "arxiv", p: 0.9407, f: "Segment_Anything", acc: true },
      { t: "DenseNet", v: "CVPR 2017", m: "arxiv", p: 0.7495, f: "DenseNet", acc: true },
      { t: "Mamba", v: "ICLR 2024", m: "iclr", p: 0.7145, f: "Mamba", acc: false },
      { t: "LoRA", full: "LoRA: Low-Rank Adaptation of Large Language Models", v: "ICLR 2022", m: "iclr", p: 0.6029, f: "LoRA", acc: true },
      { t: "LLMs Get Lost in Multi-Turn", full: "LLMs Get Lost in Multi-Turn Conversation", v: "ICLR 2026", m: "iclr", p: 0.4546, f: "LLMs_Get_Lost", acc: true },
      { t: "Dataset Bias (ICLR)", full: "A Decade's Battle on Dataset Bias (revised ICLR version)", v: "ICLR 2025", m: "iclr", p: 0.4300, f: "Decades_Battle_Dataset_Bias", acc: true },
      { t: "l-DAE", full: "Deconstructing Denoising Diffusion Models for Self-Supervised Learning", v: "ICLR 2025", m: "iclr", p: 0.3818, f: "Deconstructing_Diffusion", acc: true },
      { t: "Dataset Bias (ECCV)", full: "A Decade's Battle on Dataset Bias (ECCV version)", v: "ECCV 2024", m: "arxiv", p: 0.1000, f: "Decades_Battle_ECCV", acc: false },
    ].map((q) => ({ ...q, r: q.p / PRIOR[q.m] }));
    const pct = (x) => `${Math.round(x * 100)}%`;
    const times = (r) => `${r.toFixed(1)}×`;
    const outcome = (q) => `Accepted? <b class="${q.acc ? "yes" : "no"}">${q.acc ? "✓" : "✗"}</b>`;
    const chance = (q) => `<b class="${q.r >= 1 ? "acc" : "rej"}">${times(q.r)}</b> · ${pct(q.p)}`;
    const HI = 4.5;  // right end of the axis, in multiples of the base rate
    const lb = document.getElementById("lb");
    const open = (q) => {
      document.getElementById("lb-img").src = `./examples/${q.f}.jpg`;
      document.getElementById("lb-cap").textContent = `${q.full || q.t} (${q.v}): ${pct(q.p)} chance of acceptance (${BASE_NOTE[q.m]}), ${times(q.r)} the base rate; actually ${q.acc ? "accepted" : "rejected"}`;
      lb.showModal();
    };
    lb.addEventListener("click", () => lb.close());

    function draw() {
      const box = document.getElementById("ex-line");
      const W = box.clientWidth;
      const cw = Math.max(84, Math.floor(W * 0.095));
      const probe = document.createElement("div");
      probe.className = "ex-card"; probe.style.cssText = "visibility:hidden;left:0;top:0";
      probe.innerHTML = '<img src="./examples/DenseNet_p1.jpg" alt="" style="aspect-ratio:3/4"><span class="meta"><span class="t">x</span><span class="s">x</span><span class="a">x</span></span>';
      box.style.setProperty("--cw", cw + "px"); box.append(probe);
      const ch = probe.getBoundingClientRect().height; probe.remove();
      const laneGap = 18, axisPad = 30, titleH = 36;
      const x = (r) => (r / HI) * W;
      // One row above the axis and one below, alternating in order of the multiple. Within a row,
      // cards that would collide slide sideways and a slanted stem joins each card to its dot.
      const gap = 12;
      const placed = [...PAPERS].sort((a, b) => a.r - b.r).map((q, i) => ({ q, cx: x(q.r), lane: i % 2 ? 2 : 0 }));
      for (const lane of [0, 2]) {
        const row = placed.filter((c) => c.lane === lane);
        row.forEach((c) => { c.left = c.cx - cw / 2; });
        for (let i = 0; i < row.length; i++) row[i].left = Math.max(row[i].left, i ? row[i - 1].left + cw + gap : 0);
        for (let i = row.length - 1; i >= 0; i--) row[i].left = Math.min(row[i].left, i < row.length - 1 ? row[i + 1].left - cw - gap : W - cw);
      }
      const nUp = 1, nDown = 1;
      const above = nUp * ch + (nUp - 1) * laneGap + axisPad, below = nDown * (ch + laneGap) + axisPad + 24;
      const axisY = titleH + above;
      box.style.height = `${titleH + above + below}px`;
      box.style.setProperty("--cw", `${cw}px`);
      box.replaceChildren();
      const el = (cls, css) => { const d = document.createElement("div"); d.className = cls; Object.assign(d.style, css); box.append(d); return d; };
      el("ex-axis", { top: `${axisY - 1}px` });
      for (let r = 0; r <= 4; r += 1) {
        el("ex-tick", { left: `${x(r)}px`, top: `${axisY - 5}px` });
        el("ex-tick-lab", { left: `${Math.min(Math.max(x(r), 14), W - 18)}px`, top: `${axisY + 9}px` }).textContent = `${r}×`;
      }
      el("ex-axis-title ex-axis-title-top", { top: "0px" }).textContent = "Chance of Acceptance, Relative to the Base Rate →";
      // 1x = the paper's chance equals its venue's base rate: PaperScorer leans Accept at or above it.
      el("ex-thresh-lab", { left: `${x(1)}px`, top: `${axisY - 26}px` }).textContent = "Accept Threshold";
      const NS = "http://www.w3.org/2000/svg";
      const stems = document.createElementNS(NS, "svg");
      stems.setAttribute("class", "ex-stems");
      Object.assign(stems.style, { position: "absolute", left: "0", top: "0", width: `${W}px`, height: box.style.height, overflow: "visible", pointerEvents: "none" });
      box.append(stems);
      for (const { q, cx, left, lane } of placed) {
        const up = lane < 2, k = lane % 2;
        const top = up ? axisY - axisPad - ch - k * (ch + laneGap) : axisY + axisPad + 24 + k * (ch + laneGap);
        const line = document.createElementNS(NS, "line");
        const end = up ? top + ch : top;
        Object.entries({ x1: cx, y1: axisY, x2: left + cw / 2, y2: end, stroke: "#b9c7de", "stroke-width": 1 })
          .forEach(([a, v]) => line.setAttribute(a, v));
        stems.append(line);
        el("ex-dot", { left: `${cx}px`, top: `${axisY}px` });
        const b = document.createElement("div");
        b.setAttribute("role", "button"); b.tabIndex = 0;
        b.className = "ex-card"; b.style.left = `${left}px`; b.style.top = `${top}px`;
        b.innerHTML = `<img src="./examples/${q.f}_p1.jpg" alt="" style="aspect-ratio:3/4;object-fit:cover;object-position:top"><span class="meta"><span class="t"></span><span class="s">${chance(q)}</span><span class="a">${outcome(q)}</span></span>`;
        b.querySelector(".t").textContent = q.t;
        b.onclick = () => open(q);
        box.append(b);
      }
    }
    // Phone fallback: a ranked list with a bar on the same 0-4.5x scale.
    document.getElementById("ex-list").replaceChildren(...PAPERS.map((q) => {
      const li = document.createElement("li");
      li.innerHTML = `<img src="./examples/${q.f}.jpg" alt=""><div class="meta"><strong></strong><div class="s">${chance(q)} chance · ${BASE_NOTE[q.m]}</div><div class="a">${outcome(q)}</div><div class="bar"><i style="width:${Math.min(100, (q.r / HI) * 100)}%"></i></div></div>`;
      li.querySelector("strong").textContent = q.t;
      li.onclick = () => open(q);
      return li;
    }));
    draw();
    addEventListener("resize", draw);
