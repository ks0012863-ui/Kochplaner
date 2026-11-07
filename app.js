
import { createWorker } from "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  getFirestore, doc, collection, setDoc, addDoc,
  updateDoc, deleteDoc, getDoc, onSnapshot,
  writeBatch, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAO8KforpMCHAeGO2ixF0FVxfWVCTvajEc",
  authDomain: "kochplaner-48048.firebaseapp.com",
  projectId: "kochplaner-48048",
  storageBucket: "kochplaner-48048.firebasestorage.app",
  messagingSenderId: "449356255546",
  appId: "1:449356255546:web:61a3d1a174a910d568c003",
  measurementId: "G-CL517TNXB7"
};

const firebase = initializeApp(firebaseConfig);
const auth = getAuth(firebase);
const db = getFirestore(firebase);
const root = document.getElementById("app");

let user = null;
let householdId = null;
let recipes = [];
let shopping = [];
let mealPlan = [];
let unsubs = [];
let activeTab = "plan";

const days = ["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"];

const escapeHTML = value => String(value ?? "")
  .replaceAll("&","&amp;")
  .replaceAll("<","&lt;")
  .replaceAll(">","&gt;")
  .replaceAll('"',"&quot;")
  .replaceAll("'","&#39;");

const showError = error => {
  alert(error?.message || "Ein Fehler ist aufgetreten.");
};

function scaleIngredients(ingredients, basePersons, persons) {
  const factor = persons / (Number(basePersons) || 2);

  return String(ingredients || "")
    .split("\n")
    .map(line => {
      const match = line.trim().match(
        /^(\d+(?:[.,]\d+)?)\s*(.*)$/
      );

      if (!match) return line;

      const original = Number(match[1].replace(",", "."));
      const scaled = Math.round(original * factor * 100) / 100;

      return `${scaled.toLocaleString("de-DE")} ${match[2]}`;
    })
    .join("\n");
}

const randomId = () => crypto.randomUUID();
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)))
  .map(b => b.toString(16).padStart(2,"0")).join("");

function button(text, action, extra="") {
  return `<button data-action="${action}" ${extra}>${text}</button>`;
}

function renderLogin() {
  root.innerHTML = `
    <section class="card">
      <h2>Willkommen beim Kochplaner</h2>
      <p>Gemeinsam kochen und einkaufen.</p>
      <form id="loginForm">
        <input name="email" type="email" placeholder="E-Mail" required>
        <input name="password" type="password" placeholder="Passwort (mindestens 6 Zeichen)" minlength="6" required>
        <button type="submit" name="mode" value="login">Anmelden</button>
        <button type="button" id="register">Neues Konto erstellen</button>
      </form>
      <p id="status"></p>
    </section>`;

  const form = document.getElementById("loginForm");

  form.onsubmit = async e => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;
    try {
      await signInWithEmailAndPassword(auth,email,password);
    } catch(error) { showError(error); }
  };

  document.getElementById("register").onclick = async () => {
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || password.length < 6) {
      alert("Bitte E-Mail und Passwort mit mindestens 6 Zeichen eingeben.");
      return;
    }
    try {
      await createUserWithEmailAndPassword(auth,email,password);
    } catch(error) { showError(error); }
  };
}

async function loadUser() {
  const snap = await getDoc(doc(db,"users",user.uid));
  householdId = snap.exists() ? snap.data().householdId : null;
  if(householdId) startHousehold();
  else renderFamilySetup();
}

function renderFamilySetup() {
  root.innerHTML = `
    <section class="card">
      <h2>Deine Familie</h2>
      <p>Erstelle einen gemeinsamen Bereich oder tritt einer Familie bei.</p>
      <form id="createFamily">
        <input name="name" placeholder="Familienname" value="Unsere Familie" required>
        <button type="submit">Familie erstellen</button>
      </form>
      <hr>
      <form id="joinFamily">
        <input name="code" placeholder="Einladungscode" required>
        <button type="submit">Familie beitreten</button>
      </form>
      <button id="logout">Abmelden</button>
    </section>`;

  document.getElementById("logout").onclick = () => signOut(auth);

  document.getElementById("createFamily").onsubmit = async e => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    const id = randomId();
    const batch = writeBatch(db);
    batch.set(doc(db,"households",id),{
      owner:user.uid,name,createdAt:serverTimestamp()
    });
    batch.set(doc(db,"households",id,"members",user.uid),{
      email:user.email,joinedAt:serverTimestamp(),inviteToken:""
    });
    batch.set(doc(db,"users",user.uid),{
      email:user.email,householdId:id
    });
    try {
      await batch.commit();
      householdId=id;
      startHousehold();
    } catch(error) { showError(error); }
  };

  document.getElementById("joinFamily").onsubmit = async e => {
    e.preventDefault();
    const code = e.target.elements.code.value.trim();
    if(!/^[0-9a-f]{64}$/.test(code)) {
      alert("Bitte den vollständigen Einladungscode eingeben.");
      return;
    }
    try {
      const invite = await getDoc(doc(db,"invitations",code));
      if(!invite.exists()) throw new Error("Einladung nicht gefunden.");
      const data = invite.data();
      if(data.consumedBy || data.expiresAt.toMillis() <= Date.now())
        throw new Error("Die Einladung wurde bereits verwendet oder ist abgelaufen.");

      const id = data.householdId;
      const batch = writeBatch(db);
      batch.set(doc(db,"households",id,"members",user.uid),{
        email:user.email,joinedAt:serverTimestamp(),inviteToken:code
      });
      batch.update(doc(db,"invitations",code),{consumedBy:user.uid});
      batch.set(doc(db,"users",user.uid),{
        email:user.email,householdId:id
      });
      await batch.commit();
      householdId=id;
      startHousehold();
    } catch(error) { showError(error); }
  };
}

function startHousehold() {
  unsubs.forEach(fn=>fn());
  unsubs=[];
  for(const [path,setter] of [
    ["recipes",v=>recipes=v],
    ["shoppingList",v=>shopping=v],
    ["mealPlan",v=>mealPlan=v]
  ]) {
    const ref = collection(db,"households",householdId,path);
    unsubs.push(onSnapshot(ref,snap=>{
      setter(snap.docs.map(d=>({id:d.id,...d.data()})));
      renderApp();
    },showError));
  }
  renderApp();
}

function renderApp() {
  root.innerHTML = `
    <nav>
      ${button("Wochenplan","tab-plan")}
      ${button("Rezepte","tab-recipes")}
      ${button("Einkaufsliste","tab-shopping")}
      ${button("Familie","tab-family")}
    </nav>
    <section class="card" id="content"></section>
    <footer><button id="logout">Abmelden</button></footer>`;

  document.getElementById("logout").onclick = () => signOut(auth);
  const content = document.getElementById("content");

  if(activeTab==="plan") renderPlan(content);
  if(activeTab==="recipes") renderRecipes(content);
  if(activeTab==="shopping") renderShopping(content);
  if(activeTab==="family") renderFamily(content);

  document.querySelectorAll("[data-action^='tab-']").forEach(b=>{
    b.onclick=()=>{
      activeTab=b.dataset.action.slice(4);
      renderApp();
    };
  });
}


function renderPlan(el) {
  el.innerHTML = `
    <h2>Dein Wochenplan</h2>
    <p>Wähle ein Gericht und die Personenzahl für jeden Tag.</p>
    ${days.map((day, i) => {
      const entry = mealPlan.find(x => x.day === i);
      const persons = entry?.persons ?? 2;

      return `
        <div class="plan-day">
          <label>${day}</label>
          <select data-day="${i}">
            <option value="">Kein Gericht</option>
            ${recipes.map(r => `
              <option value="${escapeHTML(r.id)}"
                ${entry?.recipeId === r.id ? "selected" : ""}>
                ${escapeHTML(r.name)}
              </option>
            `).join("")}
          </select>

          <div class="persons-control">
            <span>Personen:</span>
            <button type="button" data-minus="${i}">−</button>
            <strong id="persons-${i}">${persons}</strong>
            <button type="button" data-plus="${i}">+</button>
          </div>
        </div>
      `;
    }).join("")}
  `;

  async function saveDay(day, changes) {
    const previous = mealPlan.find(x => x.day === day);
    const ref = doc(db, "households", householdId,
                    "mealPlan", String(day));

    try {
      await setDoc(ref, {
        day,
        recipeId: previous?.recipeId ?? "",
        persons: previous?.persons ?? 2,
        ...changes
      });
    } catch (error) {
      showError(error);
    }
  }

  el.querySelectorAll("[data-day]").forEach(select => {
    select.onchange = () => {
      saveDay(Number(select.dataset.day), {
        recipeId: select.value
      });
    };
  });

  el.querySelectorAll("[data-minus]").forEach(button => {
    button.onclick = () => {
      const day = Number(button.dataset.minus);
      const previous = mealPlan.find(x => x.day === day);
      const persons = Math.max(1, (previous?.persons ?? 2) - 1);
      saveDay(day, { persons });
    };
  });

  el.querySelectorAll("[data-plus]").forEach(button => {
    button.onclick = () => {
      const day = Number(button.dataset.plus);
      const previous = mealPlan.find(x => x.day === day);
      const persons = Math.min(12, (previous?.persons ?? 2) + 1);
      saveDay(day, { persons });
    };
  });
}

const starterRecipes = [
  {
    name: "Hähnchen-Reis-Bowl",
    basePersons: 2,
    ingredients: "300 g Hähnchenbrust\n150 g Reis\n300 g Brokkoli\n1 EL Öl",
    steps: "Reis kochen. Brokkoli garen. Hähnchen klein schneiden, würzen und in Öl anbraten. Alles zusammen servieren."
  },
  {
    name: "Spaghetti Bolognese",
    basePersons: 2,
    ingredients: "200 g Spaghetti\n250 g Rinderhackfleisch\n400 g gehackte Tomaten\n1 Zwiebel\n1 EL Öl",
    steps: "Spaghetti kochen. Zwiebel würfeln und mit Hackfleisch anbraten. Tomaten hinzufügen, 15 Minuten köcheln lassen und mit Nudeln servieren."
  },
  {
    name: "Linsen-Curry mit Reis",
    basePersons: 2,
    ingredients: "160 g rote Linsen\n120 g Reis\n200 ml Kokosmilch\n200 g gehackte Tomaten\n1 Zwiebel\n2 TL Currypulver",
    steps: "Reis kochen. Zwiebel anbraten, Linsen, Tomaten, Kokosmilch, Curry und etwas Wasser zugeben. Etwa 15 Minuten köcheln lassen."
  },
  {
    name: "Kartoffel-Ei-Pfanne",
    basePersons: 2,
    ingredients: "500 g Kartoffeln\n4 Eier\n1 Paprika\n1 Zwiebel\n1 EL Öl",
    steps: "Kartoffeln würfeln und vorgaren. Zwiebel und Paprika schneiden. Alles anbraten, Eier darübergeben und stocken lassen."
  },
  {
    name: "Hähnchen-Gemüse-Pfanne",
    basePersons: 2,
    ingredients: "300 g Hähnchenbrust\n400 g TK-Gemüse\n150 g Reis\n1 EL Öl\n2 EL Sojasauce",
    steps: "Reis kochen. Hähnchen anbraten, Gemüse hinzufügen und garen. Mit Sojasauce abschmecken."
  
  },
  {
    name: "Chili con Carne",
    basePersons: 2,
    ingredients: "250 g Rinderhackfleisch\n1 Dose Kidneybohnen\n1 Dose Mais\n400 g gehackte Tomaten\n1 Zwiebel\n1 TL Paprikapulver",
    steps: "Zwiebel und Hackfleisch anbraten. Bohnen und Mais abspülen. Mit Tomaten und Gewürzen hinzufügen und 20 Minuten köcheln lassen."
  },
  {
    name: "Thunfisch-Nudeln",
    basePersons: 2,
    ingredients: "200 g Nudeln\n1 Dose Thunfisch im eigenen Saft\n200 g passierte Tomaten\n1 Zwiebel\n100 g Erbsen",
    steps: "Nudeln kochen. Zwiebel anbraten, Tomaten und Erbsen hinzufügen. Thunfisch unterheben und mit Nudeln vermengen."
  },
  {
    name: "Gemüse-Frittata",
    basePersons: 2,
    ingredients: "5 Eier\n200 g Kartoffeln\n1 Paprika\n100 g Spinat\n50 g geriebener Käse",
    steps: "Kartoffeln vorgaren und würfeln. Gemüse in einer ofenfesten Pfanne anbraten. Eier verquirlen, darübergeben und mit Käse bei 180 Grad etwa 15 Minuten fertig garen."
  },
  {
    name: "Reis-Hackfleisch-Pfanne",
    basePersons: 2,
    ingredients: "250 g Rinderhackfleisch\n150 g Reis\n1 Paprika\n1 Zwiebel\n200 g gehackte Tomaten",
    steps: "Reis kochen. Hackfleisch mit Zwiebel anbraten. Paprika und Tomaten hinzufügen und garen. Reis unterheben."
  },
  {
    name: "Ofenkartoffeln mit Kräuterquark",
    basePersons: 2,
    ingredients: "600 g Kartoffeln\n300 g Magerquark\n100 g Naturjoghurt\n1 Gurke\n1 EL Öl\n1 TL Kräuter",
    steps: "Kartoffeln in Spalten schneiden, mit Öl würzen und bei 200 Grad etwa 30 Minuten backen. Quark mit Joghurt, Kräutern und klein geschnittener Gurke verrühren."
  },
  {
    name: "Kichererbsen-Curry",
    basePersons: 2,
    ingredients: "1 Dose Kichererbsen\n200 ml Kokosmilch\n200 g gehackte Tomaten\n120 g Reis\n1 Zwiebel\n2 TL Currypulver",
    steps: "Reis kochen. Zwiebel anbraten. Abgespülte Kichererbsen, Tomaten, Kokosmilch und Curry hinzufügen. 15 Minuten köcheln lassen."
  },
  {
    name: "Tortellini-Spinat-Pfanne",
    basePersons: 2,
    ingredients: "400 g frische Tortellini\n200 g TK-Spinat\n100 g Frischkäse\n1 Zwiebel\n1 EL Öl",
    steps: "Tortellini nach Packungsangabe garen. Zwiebel anbraten, Spinat auftauen und Frischkäse einrühren. Tortellini untermischen."
  },
  {
    name: "Puten-Geschnetzeltes",
    basePersons: 2,
    ingredients: "300 g Putenbrust\n150 g Reis\n200 g Champignons\n100 g Frischkäse\n1 Zwiebel\n1 EL Öl",
    steps: "Reis kochen. Pute in Streifen schneiden und vollständig durchbraten. Zwiebel und Champignons hinzufügen. Frischkäse mit etwas Wasser zu einer Sauce verrühren."
  },
  {
    name: "Linsen-Bolognese",
    basePersons: 2,
    ingredients: "180 g rote Linsen\n200 g Spaghetti\n400 g gehackte Tomaten\n1 Karotte\n1 Zwiebel\n1 EL Öl",
    steps: "Zwiebel und Karotte anbraten. Linsen, Tomaten und etwas Wasser zugeben und etwa 15 Minuten köcheln. Spaghetti kochen und mit Sauce servieren."
  },
  {
    name: "Hähnchen-Wraps",
    basePersons: 2,
    ingredients: "300 g Hähnchenbrust\n4 Tortilla-Wraps\n100 g Naturjoghurt\n1 Tomate\n100 g Eisbergsalat\n1 Paprika",
    steps: "Hähnchen würzen und vollständig durchbraten. Gemüse schneiden. Wraps erwärmen, mit Joghurt bestreichen und mit Hähnchen und Gemüse füllen."
  },
  {
    name: "Gemüse-Reispfanne",
    basePersons: 2,
    ingredients: "180 g Reis\n400 g TK-Gemüse\n2 Eier\n2 EL Sojasauce\n1 EL Öl",
    steps: "Reis kochen. Gemüse in Öl anbraten. Reis hinzufügen. Eier unterrühren und vollständig stocken lassen. Mit Sojasauce abschmecken."
  },
  {
    name: "Nudelauflauf mit Schinken",
    basePersons: 2,
    ingredients: "200 g Nudeln\n150 g Kochschinken\n200 g passierte Tomaten\n100 g geriebener Käse\n100 g Erbsen",
    steps: "Nudeln vorkochen. Mit Schinken, Erbsen und Tomaten in eine Auflaufform geben. Käse darüberstreuen und bei 180 Grad etwa 20 Minuten backen."
  },
  {
    name: "Kartoffel-Brokkoli-Auflauf",
    basePersons: 2,
    ingredients: "500 g Kartoffeln\n300 g Brokkoli\n150 g Frischkäse\n100 g geriebener Käse\n100 ml Milch",
    steps: "Kartoffeln in Scheiben schneiden und vorgaren. Brokkoli kurz blanchieren. Frischkäse mit Milch verrühren. Alles in eine Auflaufform geben, Käse darüberstreuen und bei 190 Grad etwa 25 Minuten backen."
  },
  {
    name: "Bohnen-Chili",
    basePersons: 2,
    ingredients: "2 Dosen Kidneybohnen\n400 g gehackte Tomaten\n1 Paprika\n1 Zwiebel\n100 g Mais\n1 TL Paprikapulver",
    steps: "Zwiebel und Paprika anbraten. Bohnen und Mais abspülen und mit Tomaten und Gewürzen hinzufügen. Etwa 20 Minuten köcheln lassen."
  },
  {
    name: "Gebratener Reis mit Ei",
    basePersons: 2,
    ingredients: "180 g Reis\n4 Eier\n200 g TK-Erbsen und Karotten\n2 EL Sojasauce\n1 EL Öl",
    steps: "Reis kochen und etwas abkühlen lassen. Gemüse anbraten, Reis hinzufügen. Eier einrühren und vollständig stocken lassen. Mit Sojasauce würzen."
  }
];


function renderRecipes(el) {
  el.innerHTML = `
    <h2>Unsere Rezepte</h2>
  
<button type="button" id="importRecipes">Starterrezepte hinzufügen</button>
  
<p>Lege fest, für wie viele Personen das Rezept ursprünglich gedacht ist.</p>
<label for="basePersons">Rezept für wie viele Personen?</label>
<input
  id="basePersons"
  name="basePersons"
  type="number"
  min="1"
  max="12"
  value="2"
  required
  form="recipeForm"
>

    <form id="recipeForm">
      <input name="name" placeholder="Gericht" required>
      <textarea name="ingredients" rows="5"
        placeholder="Zutaten: eine pro Zeile, z. B. 300 g Hähnchen"></textarea>
      <textarea name="steps" rows="4"
        placeholder="Zubereitung"></textarea>
      <button type="submit">Rezept speichern</button>
    </form>
    <hr>
    ${recipes.map(r=>`<article class="recipe">
      <h3>${escapeHTML(r.name)}</h3>
    
<label>Personen:</label>
<input
  type="number"
  min="1"
  max="12"
  value="${r.basePersons || 2}"
  data-recipe-persons="${escapeHTML(r.id)}"
>
<p data-recipe-ingredients="${escapeHTML(r.id)}">
  ${escapeHTML(r.ingredients)}
</p>
<p>${escapeHTML(r.steps)}</p>

      ${button("Zutaten zur Einkaufsliste","ingredients",`data-id="${escapeHTML(r.id)}"`)}
      ${button("Löschen","delete-recipe",`data-id="${escapeHTML(r.id)}"`)}
    </article>`).join("")}`;

el.querySelectorAll("[data-recipe-persons]").forEach(input => {
  input.oninput = () => {
    const recipe = recipes.find(r => r.id === input.dataset.recipePersons);
    if (!recipe) return;

    const persons = Number(input.value);
    if (!Number.isInteger(persons) || persons < 1 || persons > 12) return;

    const output = Array.from(
      el.querySelectorAll("[data-recipe-ingredients]")
    ).find(p => p.dataset.recipeIngredients === recipe.id);

    if (output) {
      output.textContent = scaleIngredients(
        recipe.ingredients,
        recipe.basePersons || 2,
        persons
      );
    }
  };
});

document.getElementById("importRecipes").onclick = async () => {
  const importButton = document.getElementById("importRecipes");
  importButton.disabled = true;
  importButton.textContent = "Rezepte werden hinzugefügt ...";

  try {
    const existingNames = new Set(
      recipes.map(r => r.name.trim().toLowerCase())
    );

    let added = 0;

    for (const recipe of starterRecipes) {
      if (existingNames.has(recipe.name.toLowerCase())) continue;

      await addDoc(
        collection(db, "households", householdId, "recipes"),
        {
          ...recipe,
          createdAt: serverTimestamp()
        }
      );

      existingNames.add(recipe.name.toLowerCase());
      added++;
    }

    alert(`${added} neue Rezepte hinzugefügt!`);
  } catch (error) {
    showError(error);
  } finally {
    if (importButton.isConnected) {
      importButton.disabled = false;
      importButton.textContent = "Starterrezepte hinzufügen";
    }
  }
};

  document.getElementById("recipeForm").onsubmit=async e=>{
    e.preventDefault();
    const f=e.target;
    try {
      
await addDoc(collection(db,"households",householdId,"recipes"),{
  name:f.elements.name.value.trim(),
  basePersons:Number(f.elements.basePersons.value) || 2,
  ingredients:f.elements.ingredients.value.trim(),
  steps:f.elements.steps.value.trim(),
  createdAt:serverTimestamp()
});

      f.reset();
    } catch(error) { showError(error); }
  };

  el.querySelectorAll('[data-action="ingredients"]').forEach(b=>{
    b.onclick=async()=>{
      const r=recipes.find(x=>x.id===b.dataset.id);
      if(!r)return;
      try {
        
const personsInput = Array.from(
  el.querySelectorAll("[data-recipe-persons]")
).find(input => input.dataset.recipePersons === r.id);

const persons = Number(personsInput?.value) || r.basePersons || 2;

const adjustedIngredients = scaleIngredients(
  r.ingredients,
  r.basePersons || 2,
  persons
);

for (const line of adjustedIngredients.split("\n").filter(x => x.trim())) {

          await addDoc(collection(db,"households",householdId,"shoppingList"),{
            name:line.trim(),quantity:"",checked:false,
            source:"recipe",createdAt:serverTimestamp()
          });
        }
        activeTab="shopping";
        renderApp();
      } catch(error) { showError(error); }
    };
  });

  el.querySelectorAll('[data-action="delete-recipe"]').forEach(b=>{
    b.onclick=async()=>{
      if(!confirm("Rezept löschen?"))return;
      try {
        await deleteDoc(doc(db,"households",householdId,"recipes",b.dataset.id));
      } catch(error) { showError(error); }
    };
  });
}

function weeklyIngredientId(item) {
  return encodeURIComponent(
    `${item.unit}|${item.name.toLowerCase().trim()}`
  );
}

async function toggleWeeklyIngredient(item, checked) {
  const id = weeklyIngredientId(item);

  try {
    await setDoc(
      doc(db, "households", householdId, "shoppingList", id),
      {
        name: item.name,
        quantity: "",
        checked,
        source: "weekly",
        weeklyKey: id
      },
      { merge: true }
    );
  } catch (error) {
    showError(error);
  }
}

function getWeeklyIngredients() {
  const totals = new Map();

  for (const entry of mealPlan) {
    if (!entry.recipeId) continue;

    const recipe = recipes.find(r => r.id === entry.recipeId);
    if (!recipe) continue;

    const persons = Number(entry.persons) || 2;
    const adjusted = scaleIngredients(
      recipe.ingredients,
      recipe.basePersons || 2,
      persons
    );

    for (const line of adjusted.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = trimmed.match(
        /^(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|EL|TL|Stück|Dose|Dosen)?\s+(.+)$/i
      );

      if (!match) {
        const key = trimmed.toLowerCase();
        const previous = totals.get(key);
        if (previous) previous.quantity += 1;
        else totals.set(key, {
          name: trimmed,
          quantity: 1,
          unit: "Eintrag"
        });
        continue;
      }

      let quantity = Number(match[1].replace(",", "."));
      let unit = (match[2] || "Stück").toLowerCase();
      const name = match[3].trim();

      if (unit === "kg") {
        quantity *= 1000;
        unit = "g";
      }
      if (unit === "l") {
        quantity *= 1000;
        unit = "ml";
      }
      if (unit === "dosen") unit = "dose";

      const key = `${unit}|${name.toLowerCase()}`;
      const previous = totals.get(key);

      if (previous) previous.quantity += quantity;
      else totals.set(key, { name, quantity, unit });
    }
  }

  return [...totals.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "de")
  );
}


function renderShopping(el) {
  const weeklyIngredients = getWeeklyIngredients();

  const manualShopping = shopping.filter(
    item => item.source !== "weekly"
  );

  el.innerHTML=`
    <h2>Automatisch aus deinem Wochenplan</h2>
    <p>Diese Zutaten werden aus den ausgewählten Gerichten und Personenzahlen berechnet.</p>

    <ul class="shopping-list">
      ${weeklyIngredients.length
        ? weeklyIngredients.map(item => `
          
<li>
  <input
    type="checkbox"
    data-weekly-check="${escapeHTML(weeklyIngredientId(item))}"
    ${shopping.some(x =>
      x.source === "weekly" &&
      x.weeklyKey === weeklyIngredientId(item) &&
      x.checked
    ) ? "checked" : ""}
  >
  <span>
    ${escapeHTML(
      item.unit === "Eintrag"
        ? `${item.quantity} × ${item.name}`
        : `${item.quantity.toLocaleString("de-DE")} ${item.unit} ${item.name}`
    )}
  </span>
</li>

        `).join("")
        : "<li>Wähle zuerst Gerichte im Wochenplan aus.</li>"
      }
    </ul>
    <hr>

    <h2>Gemeinsame Einkaufsliste</h2>
    <form id="addItem">
      <input name="name" placeholder="Artikel, z. B. Milch" required>
      <input name="quantity" placeholder="Menge, z. B. 2 Liter">
      <button type="submit">Artikel hinzufügen</button>
    </form>
  
<p>${manualShopping.filter(x=>x.checked).length} von ${manualShopping.length} erledigt</p>

    <ul class="shopping-list">

${manualShopping.sort((a,b)=>Number(a.checked)-Number(b.checked)).map(x=>`

        <li>
          <input type="checkbox" data-check="${escapeHTML(x.id)}"
            ${x.checked?"checked":""}>
          <span>${escapeHTML(x.name)} ${escapeHTML(x.quantity)}</span>
          ${button("Entfernen","delete-item",`data-id="${escapeHTML(x.id)}"`)}
        </li>`).join("")}
    </ul>`;

el.querySelectorAll("[data-weekly-check]").forEach(box => {
  box.onchange = async () => {
    const item = getWeeklyIngredients().find(
      x => weeklyIngredientId(x) === box.dataset.weeklyCheck
    );

    if (item) {
      await toggleWeeklyIngredient(item, box.checked);
    }
  };
});

  document.getElementById("addItem").onsubmit=async e=>{
    e.preventDefault();
    const f=e.target;
    try {
      await addDoc(collection(db,"households",householdId,"shoppingList"),{
        name:f.elements.name.value.trim(),
        quantity:f.elements.quantity.value.trim(),
        checked:false,source:"manual",createdAt:serverTimestamp()
      });
      f.reset();
    } catch(error) { showError(error); }
  };

  el.querySelectorAll("[data-check]").forEach(c=>{
    c.onchange=async()=>{
      try {
        await updateDoc(doc(db,"households",householdId,"shoppingList",c.dataset.check),{
          checked:c.checked
        });
      } catch(error) { showError(error); }
    };
  });

  el.querySelectorAll('[data-action="delete-item"]').forEach(b=>{
    b.onclick=async()=>{
      try {
        await deleteDoc(doc(db,"households",householdId,"shoppingList",b.dataset.id));
      } catch(error) { showError(error); }
    };
  });
}

async function renderFamily(el) {
  el.innerHTML=`
    <h2>Unsere Familie</h2>
    <p>Eigene Benutzerkonten mit gemeinsamer Einkaufsliste.</p>
    <button id="invite">Einladungscode erstellen</button>
    <p id="inviteResult"></p>`;

  document.getElementById("invite").onclick=async()=>{
    const code=token();
    try {
      await setDoc(doc(db,"invitations",code),{
        householdId,
        createdBy:user.uid,
        consumedBy:null,
        expiresAt:Timestamp.fromMillis(Date.now()+7*24*60*60*1000)
      });
      const output=document.getElementById("inviteResult");
      output.textContent="Einladungscode (7 Tage gültig): "+code;
      const copy=document.createElement("button");
      copy.textContent="Code kopieren";
      copy.onclick=()=>navigator.clipboard.writeText(code).catch(showError);
      output.append(document.createElement("br"),copy);
    } catch(error) { showError(error); }
  };
}

onAuthStateChanged(auth,async current=>{
  unsubs.forEach(fn=>fn());
  unsubs=[];
  user=current;
  householdId=null;
  if(!user) {
    renderLogin();
    return;
  }
  try {
    await loadUser();
  } catch(error) {
    showError(error);
    renderFamilySetup();
  }
});
