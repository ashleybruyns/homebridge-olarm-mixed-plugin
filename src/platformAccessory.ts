import { Service, PlatformAccessory, CharacteristicValue, Characteristic, API } from 'homebridge';

import { OlarmHomebridgePlatform } from './platform';
import { Olarm, OlarmArea, OlarmAreaState, OlarmPGMCommand, OlarmZoneState } from './olarm';
import { OlarmAreaAction } from './olarm';

enum CurrentDoorState {
  OPEN = 0,
  CLOSED = 1,
  OPENING = 2,
  CLOSING = 3,
  STOPPED = 4,
};

enum TargetDoorState {
  OPEN = 0,
  CLOSED = 1
};

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class OlarmAreaPlatformAccessory {
  private service: Service;
  private garageService!: Service;
  private currentState: OlarmAreaState = OlarmAreaState.Disarmed;
  private targetState: OlarmAreaState = OlarmAreaState.Disarmed;
  // private motionSensorOneService: Service;
  private currentOlarmAreaState!: OlarmArea;
  private currentDoorState: CurrentDoorState = CurrentDoorState.CLOSED;
  private timeoutHandle: any;
    
  constructor(
    private readonly platform: OlarmHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Olarm');

    // get the SecuritySystem service if it exists, otherwise create a new SecuritySystem service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.SecuritySystem) || this.accessory.addService(this.platform.Service.SecuritySystem);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.context.area.areaName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/SecuritySystem

    // register handlers for the SecuritySystemCurrentState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState)
      .onGet(this.handleSecuritySystemCurrentStateGet.bind(this));

    // register handlers for the SecuritySystemTargetState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.SecuritySystemTargetState)
      .onGet(this.handleSecuritySystemTargetStateGet.bind(this))
      .onSet(this.handleSecuritySystemTargetStateSet.bind(this));

    // Initialize the states
    this.currentState = this.accessory.context.area.areaState;
    this.targetState = this.currentState;

    if (this.platform.config.garageDoor.zone && this.platform.config.garageDoor.zone !== undefined &&
      this.platform.config.garageDoor.PGM && this.platform.config.garageDoor.PGM !== undefined)
    {
      this.platform.log.info(`Add garage door sensor for zone: ${this.platform.config.garageDoor.zone.toString()}`);
      
      // get the GarageDoor System service if it exists, otherwise create a new GarageDoorOpener service
      // you can create multiple services for each accessory
      this.garageService = this.accessory.getService(this.platform.Service.GarageDoorOpener) || this.accessory.addService(this.platform.Service.GarageDoorOpener);

      // set the service name, this is what is displayed as the default name on the Home app
      // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
      this.garageService.setCharacteristic(this.platform.Characteristic.Name, this.accessory.context.area.areaName + " Garage Door");
      this.garageService.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, this.platform.Characteristic.CurrentDoorState.CLOSED);
      this.garageService.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this.platform.Characteristic.TargetDoorState.CLOSED);

      // each service must implement at-minimum the "required characteristics" for the given service type
      // see https://developers.homebridge.io/#/service/GarageDoorOpener

      // register handlers for the SecuritySystemCurrentState Characteristic
      this.garageService.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
        .onGet(this.handleGarageDoorCurrentStateGet.bind(this));

      // register handlers for the SecuritySystemTargetState Characteristic
      this.garageService.getCharacteristic(this.platform.Characteristic.TargetDoorState)
        .onSet(this.handleGarageDoorTargetStateSet.bind(this));      
    }

    // Initialize occupancy sensors
    // Loop through all configured PIR zones and create an occupancy sensor for each one 
    this.platform.config.occupancyZones.forEach((zone: number) => {
      this.platform.log.debug(`Add occupancy sensor for zone: ${zone.toString()}`);
      const sensorName: string = `Zone ${zone.toString()} Sensor`;
      let occupancySensorService : Service;
      occupancySensorService = this.accessory.getService(sensorName) ||
        this.accessory.addService(this.platform.Service.OccupancySensor, sensorName, `${this.accessory.context.area.areaName}-Zone${zone.toString()}Sensor`);
      
      occupancySensorService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
      occupancySensorService.setCharacteristic(this.platform.Characteristic.ConfiguredName, sensorName);

      this.platform.log.debug(`Occupancy sensor: "${sensorName}" / "${this.accessory.context.area.areaName}-Zone${zone.toString()}Sensor" added`);
    });

    // setInterval(async () => {
    setInterval(() => {
      this.getOccupancyZones();
    }, this.platform.config.pollingInterval);
  }

  convertFromOlarmAreaState = (s: OlarmAreaState): CharacteristicValue => {

    /**
     * APPLE  OLARM
     * Home   <unused> -> Stay
     * Away   Armed
     * Night  Stay
     * Off    Disarmed
     * ...
     */
    switch (s) {
      case OlarmAreaState.Armed:
        return this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM; // Away => Armed
      case OlarmAreaState.ArmedStay:
        return this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM; // Night => Stay
      case OlarmAreaState.Disarmed:
        return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
      case OlarmAreaState.NotReady:
        return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
      case OlarmAreaState.Triggered: // todo
      default:
        return this.platform.Characteristic.SecuritySystemCurrentState.DISARMED;
    }
    // static readonly STAY_ARM = 0; // "Home"
    // static readonly AWAY_ARM = 1; // "Away"
    // static readonly NIGHT_ARM = 2; // "Night"
    // static readonly DISARMED = 3; // "Off"
    // static readonly ALARM_TRIGGERED = 4; // ?
  };

  convertToOlarmAreaState = (s: CharacteristicValue): OlarmAreaState => {
    switch (s) {
      case this.platform.Characteristic.SecuritySystemCurrentState.STAY_ARM:
        return OlarmAreaState.ArmedStay;
      case this.platform.Characteristic.SecuritySystemCurrentState.AWAY_ARM:
        return OlarmAreaState.Armed;
      case this.platform.Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
        return OlarmAreaState.ArmedStay;
      case this.platform.Characteristic.SecuritySystemCurrentState.DISARMED:
        return OlarmAreaState.Disarmed;
      case this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
        return OlarmAreaState.Triggered; // todo
      default:
        return OlarmAreaState.Disarmed;
    }
  };

  // Validate if PIR Zone has triggered based on configured occupancy delay time
  convertFromOlarmZoneOccupancy = (zone: number, olarmArea: OlarmArea): CharacteristicValue => {

    // Check zone timestamp vs device timestamp against polling interval
    this.platform.log.debug('Zone Occupancy check for zone: ' + zone + ' ZoneStamp: ' + olarmArea.zonesStamp[zone - 1] + ' DeviceStamp: ' + olarmArea.deviceTimestamp)
    const differenceInMs = olarmArea.deviceTimestamp - olarmArea.zonesStamp[zone - 1];
    if (differenceInMs < this.platform.config.occupancyDelay) {
      this.platform.log.info(`GET ZoneState for Zone ` + zone + ' Set to OCCUPANCY_DETECTED');
      return this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED;
    }
    else {
      this.platform.log.info(`GET ZoneState for Zone ` + zone + ' Set to OCCUPANCY_NOT_DETECTED');
      return this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
    }
  };

  convertFromOlarmZoneToCurrentDoorState = (s: string): CurrentDoorState => {

    /**
     * APPLE  OLARM
     * c (closed) = Closed
     * a (active) = Open
     * b (bypassed) = closed
     */
    switch (s) {
      case OlarmZoneState.Active:
        return CurrentDoorState.OPEN;
      case OlarmZoneState.Closed:
        return CurrentDoorState.CLOSED;
      case OlarmZoneState.Bypassed:
        return CurrentDoorState.CLOSED;
      default:
        return CurrentDoorState.CLOSED;
    }
  };

  /**
     * Handle requests to get the current value of the "Security System Current State" characteristic
     */
  async handleSecuritySystemCurrentStateGet() {
    let olarmArea: OlarmArea;

    // Ensure min 15 seconds between API query    
    if (this.currentOlarmAreaState !== undefined && this.currentOlarmAreaState !== null && this.currentOlarmAreaState.deviceTimestamp + 15000 > Date.now()) {
      this.platform.log.info(`GET Cache State Epoch ${this.currentOlarmAreaState.deviceTimestamp.toString()} System Epoch ${Date.now().toString()}`);
      olarmArea = this.currentOlarmAreaState;
    }
    else {
      const olarmAreas = await this.platform.olarm.getAreas();
      const area = this.accessory.context.area as OlarmArea;
      olarmArea = olarmAreas.find(oa => oa.areaName === area.areaName)!;

      // Store current state of olarm info
      this.currentOlarmAreaState = olarmArea!;
    }   

    this.platform.log.info(`GET CurrentState (${olarmArea?.areaName}) from ${this.currentState} to ${olarmArea!.areaState} (target: ${this.targetState})`);
    this.currentState = olarmArea!.areaState;

    if (this.currentState !== OlarmAreaState.NotReady)
      this.targetState = this.currentState;

    // Update HomeKit state
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState, this.convertFromOlarmAreaState(this.currentState));
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, this.convertFromOlarmAreaState(this.targetState));

    return this.convertFromOlarmAreaState(olarmArea!.areaState);
  }

  /**
   * Handle requests to get the current value of the "Security System Target State" characteristic
   */
  async handleSecuritySystemTargetStateGet() {
    this.platform.log.info(`GET TargetState (${this.accessory.context.area.areaName}) ${this.targetState} (current: ${this.currentState})`);
    return this.convertFromOlarmAreaState(this.targetState);
  }

  /**
   * Handle requests to set the "Security System Target State" characteristic
   */
  async handleSecuritySystemTargetStateSet(value: CharacteristicValue) {
    const olarmAreaStateValue = this.convertToOlarmAreaState(value);

    // Determine olarm action
    const area = this.accessory.context.area;
    let olarmAreaAction = OlarmAreaAction.Disarm;
    if (olarmAreaStateValue === OlarmAreaState.Armed)
      olarmAreaAction = OlarmAreaAction.Arm;
    if (olarmAreaStateValue === OlarmAreaState.ArmedStay)
      olarmAreaAction = OlarmAreaAction.Stay;

    this.platform.log.info(`SET TargetState (${this.accessory.context.area.areaName}) from ${this.targetState} to ${olarmAreaStateValue} with "${olarmAreaAction}"`);
    this.targetState = olarmAreaStateValue;

    // Ping olarm to update
    await this.platform.olarm.setArea(area, olarmAreaAction);

    // Update actual state
    this.currentState = this.targetState;
    this.platform.log.info(' - (SET) Updated', this.accessory.context.area.areaName, 'to', olarmAreaStateValue);

    // Update HomeKit state
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemCurrentState, this.convertFromOlarmAreaState(this.currentState));
    this.service.updateCharacteristic(this.platform.Characteristic.SecuritySystemTargetState, this.convertFromOlarmAreaState(this.targetState));
  }

  async getOccupancyZones() {
    this.platform.log.debug(`Get Occupancy zones for configured zones`);
      
    // Schedule security event, refreshing alarm data
    await this.handleSecuritySystemCurrentStateGet();
    await this.handleGarageDoorCurrentStateGet();

    this.platform.config.occupancyZones.forEach((zone: number) => {
      this.platform.log.debug(`Get occupancy sensor for zone: ${zone.toString()}`);
      this.accessory.getService(`Zone ${zone.toString()} Sensor`)!.updateCharacteristic(this.platform.Characteristic.OccupancyDetected, this.convertFromOlarmZoneOccupancy(zone, this.currentOlarmAreaState));
    });
  }

  /**
   * Handle requests to get the current value of the "Security System Target State" characteristic
   */
  async handleGarageDoorCurrentStateGet() {
    this.platform.log.info(`GET Current Garage Door state for zone ${this.platform.config.garageDoor.zone}`);

    let queryDoorState = this.convertFromOlarmZoneToCurrentDoorState(this.currentOlarmAreaState?.zones[this.platform.config.garageDoor.zone - 1] ?? this.platform.Characteristic.CurrentDoorState.CLOSED);
        
    switch (this.currentDoorState) {
      case CurrentDoorState.OPEN:
      case CurrentDoorState.CLOSED:        
        this.setCurrentAndTargetDoorState(queryDoorState);
        this.platform.log.info(`Current Garage Door state for zone ${this.platform.config.garageDoor.zone} is set to ${ CurrentDoorState[Number(queryDoorState)]}`);
        return queryDoorState;
      case CurrentDoorState.OPENING:
      case CurrentDoorState.CLOSING:
        this.platform.log.debug(`Current Garage Door state for zone ${this.platform.config.garageDoor.zone} is set to ${ CurrentDoorState[Number(this.currentDoorState)]}`);
        // if status has not changed in more than 1 min update current state and target state
        if (this.currentOlarmAreaState?.zonesStamp[this.platform.config.garageDoor.zone - 1] + 60000 < Date.now()) { 
          this.setCurrentAndTargetDoorState(queryDoorState);
          this.platform.log.info(`Current Garage Door state for zone ${this.platform.config.garageDoor.zone} is set to ${ CurrentDoorState[Number(this.currentDoorState)]}`);
        }
        else {
          return this.currentDoorState;  
        }
      default:
        return this.currentDoorState;
    }
  }

  readonly setCurrentDoorState = (state: CurrentDoorState) => {
    this.platform.log.debug('Setting current door state to ' + CurrentDoorState[state]);
    this.currentDoorState = state;
    this.garageService
        .getCharacteristic(this.platform.Characteristic.CurrentDoorState)
        .setValue(state);
  };

  readonly setCurrentAndTargetDoorState = (state: CurrentDoorState) => {
    this.platform.log.debug('Setting current door and target state to ' + CurrentDoorState[state]);
    this.currentDoorState = state;
    this.garageService
        .getCharacteristic(this.platform.Characteristic.CurrentDoorState)
        .setValue(state);
    this.garageService
        .getCharacteristic(this.platform.Characteristic.TargetDoorState)
        .setValue(state);
  };

  /**
   * Handle requests to set the "Security System Target State" characteristic
   */
  async handleGarageDoorTargetStateSet(targetState: CharacteristicValue) {   
    // let targetState = Number(value);
    this.platform.log.debug('Target State set to ' + TargetDoorState[Number(targetState)]);
    switch (this.currentDoorState) {
      case CurrentDoorState.OPEN:
          if (targetState == TargetDoorState.CLOSED) {
              this.sendRemotePulseSignal();
              this.currentDoorState = CurrentDoorState.CLOSING;
              this.timeoutHandle = setTimeout(() => this.setCurrentDoorState(CurrentDoorState.CLOSED), this.platform.config.garageDoor.doorDelay);
          }
          break;
      case CurrentDoorState.CLOSED:          
          if (targetState == TargetDoorState.OPEN) {
              this.sendRemotePulseSignal();
              this.setCurrentDoorState(CurrentDoorState.OPENING);
              this.timeoutHandle = setTimeout(() => this.setCurrentDoorState(CurrentDoorState.OPEN), this.platform.config.garageDoor.doorDelay);
          }
          break;
      case CurrentDoorState.OPENING:
      case CurrentDoorState.CLOSING:
          if (this.currentDoorState === CurrentDoorState.OPENING && targetState == TargetDoorState.CLOSED
              || this.currentDoorState === CurrentDoorState.CLOSING && targetState == TargetDoorState.OPEN) {
              clearTimeout(this.timeoutHandle);
              if (this.currentDoorState === CurrentDoorState.OPENING) {
                  this.setCurrentDoorState(CurrentDoorState.CLOSING);
              } else {
                  this.setCurrentDoorState(CurrentDoorState.OPENING);
              }
          }
          break;
      case CurrentDoorState.STOPPED:
          break;
  }
  }

  async sendRemotePulseSignal() {
    // Ping olarm to update
    this.platform.log.info(`Send remote pulse signal via PGM Zone: ${this.platform.config.garageDoor.PGM}`);
    await this.platform.olarm.setPGM(this.currentOlarmAreaState, this.platform.config.garageDoor.PGM, OlarmPGMCommand.Pulse);    
}


}
