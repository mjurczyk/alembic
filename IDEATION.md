# Structure

* Base the repository structure on STRUCTURE (NOT contents) of openvdb (https://github.com/mjurczyk/openvdb/)
* Three integral component parts are needed to be planned out:

  * /alembic - JS implementation of .ABC file format (using either DataView or strings, either works)
  * /three-alembic - Three.js implementation (WebGL / GLSL, NOT TSL)
  * /wabc - .abc -> .wabc CLI that optimises the file format

* General guidelines:
  
  * 1) We ARE NOT porting alembic 1:1 byte-wise; first step is to define the FILE FORMAT, and outline it in a RESEARCH DOCUMENT -> line by line, what is stored where, how
  * 2) We ARE NOT adding ANYTHING outside of the 3 initial dirs, no workflows, no releases, no complex demos: (a) ONLY alembic dir for base format loader that loads .ABC into JS memory; (b) JUST /alembic AND /three-alembic to validate three.js shaders are able to render loaded .ABC file as WebGL shader; (c) then AND ONLY THEN /wabc, which should optimise .abc into .wabc, proposing adjustments to /alembic to allow reading wabs as well

    * NONE of these steps should be done at the same time; CONSECUTIVE step can ONLY be done after previous has been MANUALLY TESTED and MERGED BY A HUMAN into active branch