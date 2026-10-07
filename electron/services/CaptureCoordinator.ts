import { EventEmitter } from "node:events";
import type {
  CaptureLifecycleEvent,
  CaptureRequest,
  CaptureState,
  PushToTalkEvent,
  TargetBindingEvent,
} from "../../shared/contracts.js";
import {
  CaptureStateMachine,
  type CaptureTransition,
} from "../../shared/capture-state.js";

export class CaptureCoordinator extends EventEmitter {
  private readonly machine = new CaptureStateMachine();

  getState(): CaptureState {
    return this.machine.getState();
  }

  handlePushToTalk(event: PushToTalkEvent): CaptureState {
    return this.publish(this.machine.handlePushToTalk(event));
  }

  request(action: CaptureRequest): CaptureState {
    return this.publish(this.machine.request(action));
  }

  acceptLifecycle(event: CaptureLifecycleEvent): CaptureState {
    return this.publish(this.machine.acceptLifecycle(event));
  }

  fail(error: string): CaptureState {
    return this.publish(this.machine.fail(error));
  }

  acceptTargetBinding(event: TargetBindingEvent): CaptureState {
    return this.publish(this.machine.acceptTargetBinding(event));
  }

  setTargetIcon(targetContextId: string, dataUrl: string): CaptureState {
    return this.publish(this.machine.setTargetIcon(targetContextId, dataUrl));
  }

  private publish(transition: CaptureTransition): CaptureState {
    if (transition.changed) this.emit("state", transition.state);
    return transition.state;
  }
}
