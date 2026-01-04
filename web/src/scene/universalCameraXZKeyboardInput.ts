import { Axis, FreeCameraKeyboardMoveInput, UniversalCamera } from "@babylonjs/core";

/**
 * Keyboard movement that always stays on the XZ plane (Doom-style),
 * so looking up/down does not change ground speed.
 */
export class UniversalCameraXZKeyboardInput extends FreeCameraKeyboardMoveInput {
  // Make TS happy: this input will be attached to a UniversalCamera (a FreeCamera subclass).
  declare public camera: UniversalCamera;

  public override checkInputs(): void {
    const camera = this.camera;

    // Forward/right directions from the camera, then flattened to XZ.
    const front = camera.getDirection(Axis.Z);
    const right = camera.getDirection(Axis.X);

    // Babylon's FreeCameraKeyboardMoveInput stores pressed keys in a private field.
    const keys = (this as any)._keys as number[];

    if (keys.length > 0) {
      front.y = 0;
      if (front.lengthSquared() > 1e-6) front.normalize();

      right.y = 0;
      if (right.lengthSquared() > 1e-6) right.normalize();
    }

    for (let index = 0; index < keys.length; index++) {
      const keyCode = keys[index]!;
      const speed = (camera as any)._computeLocalCameraSpeed();

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
