
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

function renderRecipes(el) {
  el.innerHTML = `
    <h2>Unsere Rezepte</h2>
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
      <p>${escapeHTML(r.ingredients)}</p>
      <p>${escapeHTML(r.steps)}</p>
      ${button("Zutaten zur Einkaufsliste","ingredients",`data-id="${escapeHTML(r.id)}"`)}
      ${button("Löschen","delete-recipe",`data-id="${escapeHTML(r.id)}"`)}
    </article>`).join("")}`;

  document.getElementById("recipeForm").onsubmit=async e=>{
    e.preventDefault();
    const f=e.target;
    try {
      await addDoc(collection(db,"households",householdId,"recipes"),{
        name:f.elements.name.value.trim(),
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
        for(const line of r.ingredients.split("\n").filter(x=>x.trim())){
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

function renderShopping(el) {
  el.innerHTML=`
    <h2>Gemeinsame Einkaufsliste</h2>
    <form id="addItem">
      <input name="name" placeholder="Artikel, z. B. Milch" required>
      <input name="quantity" placeholder="Menge, z. B. 2 Liter">
      <button type="submit">Artikel hinzufügen</button>
    </form>
    <p>${shopping.filter(x=>x.checked).length} von ${shopping.length} erledigt</p>
    <ul class="shopping-list">
      ${shopping.sort((a,b)=>Number(a.checked)-Number(b.checked)).map(x=>`
        <li>
          <input type="checkbox" data-check="${escapeHTML(x.id)}"
            ${x.checked?"checked":""}>
          <span>${escapeHTML(x.name)} ${escapeHTML(x.quantity)}</span>
          ${button("Entfernen","delete-item",`data-id="${escapeHTML(x.id)}"`)}
        </li>`).join("")}
    </ul>`;

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
