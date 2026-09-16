/* Calibrated only against batch03/lab exports from 85fc38d52. Points refer to the
   complete exported PNG, not the pre-export image and not the fitted world box. */
'use strict';
const AuthoredMachineConfig = (() => {
  const palette={dark:'#171b1c',edge:'#343b3c',metal:'#59615d',light:'#a2a397',accent:'#8c7952'};
  const specs={
    fabricator:{
      image:'fabricator.png',
      sha256:'89cce468370781ab4ed272c0fa6e9e94d1ad4cd169c83ca8888f576d295ba5c3',
      bounds:{x:-3,y:-4,width:44,height:28},footprint:{w:3,h:2},
      layers:{carriage:'fabricator_carriage.png'},
      motion:{kind:'gantry',sourceWidth:1486,sourceHeight:722,period:4200,
        clip:[[.30,.04],[.87,.04],[.87,.66],[.30,.66]],
        from:[.37685,.277],to:[.79071,.277],size:[.0875,.4],layer:'carriage'}
    },
    tube:{
      image:'tube.png',
      sha256:'a714eb08baec8a2a13dabfaa9eb189c53f8827615b6797a3c6c16b16f33a109a',
      bounds:{x:-1,y:-4,width:26,height:15},footprint:{w:2,h:1},layers:{},
      motion:{kind:'tube',sourceWidth:1596,sourceHeight:757,period:2600,
        clip:[[.241,.338],[.75,.338],[.77,.4],[.77,.642],[.75,.70],[.241,.70],[.221,.642],[.221,.4]],
        from:[.197,.52],to:[.799,.52],size:[.15,.16],palette}
    },
    etsy_packbot:{
      image:'etsy_packbot.png',
      sha256:'ea148d64077f983a3e50a1a3e8922025c9135a5a4ad296510f0989a13afb3dfc',
      bounds:{x:-1,y:-15,width:30,height:39},footprint:{w:2,h:2},layers:{},
      motion:{kind:'arm',sourceWidth:1003,sourceHeight:1173,period:4400,
        clip:[[.17,.025],[.98,.025],[.98,.74],[.17,.74]],
        shoulder:[.85244,.16198],rest:[.49,.44],pickup:[.38,.58],place:[.66,.58],
        upper:.37,fore:.34,thickness:.09,joint:.074,tool:.095,bend:1,palette}
    }
  };
  function freeze(value){if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}
  freeze(specs);
  const ids=Object.freeze(Object.keys(specs));
  const get=id=>Object.prototype.hasOwnProperty.call(specs,id)?specs[id]:null;
  return Object.freeze({ids,get,byId:specs,sourceRoot:'assets/industrial/batch03/lab/'});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AuthoredMachineConfig;
