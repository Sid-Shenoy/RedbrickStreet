# Redbrick Street

Redbrick Street is a first-person zombie shooter that runs straight in the browser. As Officer Steve, you find yourself on a quiet suburban street that is not quiet anymore, and the goal is simple: survive long enough to wipe out every zombie on the map. No menus, no launcher, no installs required. Just open the link and you are in.

Play it here: https://sid-shenoy.github.io/RedbrickStreet/

## What this project is really about

I built this because I wanted one project that forced me to use a bunch of different tech-related skills at the same time. I wanted computer graphics, procedural generation, and gameplay systems all in the same codebase. I also wanted the project to be big enough that it actually feels like working in a real codebase, where you have to keep your own conventions straight or things get messy fast.

Under the hood, the street is not just a static scene. Each house has a layout that is generated procedurally in a deterministic way. The zombie system also uses AI and pathfinding, which enables zombies to chase the player indoors through a network of rooms and doorways. Zombies stream in as interiors load, they switch between idle, chase, and attack states based on distance, and they drive the player’s health state through actual gameplay callbacks. On top of that, the weapon system is meant to challenge the player while remaining intuitive to use. There is a weapon wheel, number-key switching, fire rates, ammo tracking, reload behavior, and a win sequence when you finally clear the street.

## How to play

The controls are roughly what you would expect if you have played any first-person game on PC. You move with WASD, sprint with Shift, and jump with Space. You aim with the mouse and shoot with left click. Tab opens the weapon wheel, and you can also switch weapons using the number keys.

You win when the zombie counter hits zero. You lose when your health reaches zero.

## Main features

The biggest part of the project is the procedural street/house generation. Each house has a two-floor layout with regions for things like rooms, hallways, stairs, and outdoor plot zones. The output is deterministic, so the same house number always generates the same layout for a given seed, which makes debugging and iteration much easier.

The zombie system was the other main focus. Zombies are spawned across the street based on a pseudorandom deterministic layout, and then instantiated lazily when interiors are loaded. Their movement is intentionally simple and performance-friendly, but the AI is still Advanced enough to put real pressure on the player. They will chase you when you are close enough and attack when they get within range, and that damage actually matters because the game can end quickly if you ignore them.

Finally, the combat loop is where everything meets. Weapons have different fire rates and damage, there is an actual ammo model with clip and reserve rounds, and the UI tries to communicate what you need in a simple and user-friendly manner.

## A known limitation

Shooting does not do occlusion checks. In other words, the raycast only cares about zombie hitboxes and ignores walls or objects in between. This is intentional for now because it keeps combat consistent and avoids a bunch of messy edge cases while the level geometry is still evolving.
