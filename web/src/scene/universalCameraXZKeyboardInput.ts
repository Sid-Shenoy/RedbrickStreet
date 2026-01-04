import {
  Axis,
  FreeCameraKeyboardMoveInput,
  KeyboardEventTypes,
  KeyboardInfo,
  Nullable,
  Observer,
  UniversalCamera,
} from "@babylonjs/core";

/**
 * Keyboard movement that always stays on the XZ plane (Doom-style),
 * so looking up/down does not change ground speed.
 *
 * Also supports sprinting while holding Shift (default x2).
 */
export class UniversalCameraXZKeyboardInput extends FreeCameraKeyboardMoveInput {
  // This input will be attached to a UniversalCamera (a FreeCamera subclass).
  declare public camera: UniversalCamera;

  public sprintMultiplier = 2;

  private _sprintHeld = false;
  private _sprintKbObserver: Nullable<Observer<KeyboardInfo>> = null;

  public override attachControl(noPreventDefault?: boolean): void {
    super.attachControl(noPreventDefault);

    // Track Shift independently (Shift is not part of the movement key list).
    if (!this._sprintKbObserver) {
      const scene = this.camera.getScene();

      this._sprintKbObserver = scene.onKeyboardObservable.add((kbInfo) => {
        const ev = kbInfo.event;

        if (ev.code !== "ShiftLeft" && ev.code !== "ShiftRight") return;

        if (kbInfo.type === KeyboardEventTypes.KEYDOWN) this._sprintHeld = true;
        if (kbInfo.type === KeyboardEventTypes.KEYUP) this._sprintHeld = false;
      });
    }
  }

  public override detachControl(ignored?: any): void {
    const scene = this.camera?.getScene?.();

    if (scene && this._sprintKbObserver) {
      scene.onKeyboardObservable.remove(this._sprintKbObserver);
      this._sprintKbObserver = null;
    }

    this._sprintHeld = false;

    super.detachControl(ignored);
  }

  public override checkInputs(): void {
    const camera = this.camera;

    // Forward/right directions from the camera, then flattened to XZ.
    const front = camera.getDirection(Axis.Z);
    const right = camera.getDirection(Axis.X);

    // Babylon's FreeCameraKeyboardMoveInput stores pressed movement keys in a private field.
    const keys = (this as any)._keys as number[];

    if (keys.length > 0) {
      front.y = 0;
      if (front.lengthSquared() > 1e-6) front.normalize();

      right.y = 0;
      if (right.lengthSquared() > 1e-6) right.normalize();
    }

    const baseSpeed = (camera as any)._computeLocalCameraSpeed();
    const speed = this._sprintHeld ? baseSpeed * this.sprintMultiplier : baseSpeed;

    for (let index = 0; index < keys.length; index++) {
      const keyCode = keys[index]!;

      (camera as any)._localDirection.copyFromFloats(0, 0, 0);

      if (this.keysLeft.indexOf(keyCode) !== -1) {
        (camera as any)._localDirection.subtractInPlace(right);
      } else if (this.keysUp.indexOf(keyCode) !== -1) {
        (camera as any)._localDirection.addInPlace(front);
      } else if (this.keysRight.indexOf(keyCode) !== -1) {
        (camera as any)._localDirection.addInPlace(right);
      } else if (this.keysDown.indexOf(keyCode) !== -1) {
        (camera as any)._localDirection.subtractInPlace(front);
      }

      (camera as any)._localDirection.scaleInPlace(speed);

      if (camera.getScene().useRightHandedSystem) {
        (camera as any)._localDirection.z *= -1;
      }

      camera.cameraDirection.addInPlace((camera as any)._localDirection);
    }
  }
}
